"""PR #199 fix round 20, review 18's backend items.

- handoff-reopen MEDIUM-1: a tab-local node's delete is said, never read from
  an omission. Nebula records which of the person's windows saved each
  tab-local node (``_tabLocalWriters``), and a handoff deletes a renumbered
  node only when its ``deletedNodeIds`` lists it (by the old id or the new
  one) and the window sending it is the one that saved it. Another window's
  handoff, which never had the node, keeps it and the agent's edit.
- handoff-reopen MEDIUM-3: a node's run result (outputs, state, notes,
  error, batch previews) moves through the handoff as one unit, for every
  node Nebula holds; the newer run wins (node_result_runs), and the result
  goes onto the live graph.
- handoff-reopen LOW-1: the person's reopen in place keeps a handoff, and
  its sync carries ``projectSwitch`` with ``actor`` {"kind": "person",
  "tab"}, so the person's other windows follow and their typing lands.
- handoff-reopen LOW-2: a renumber moves World Labs recovery checkpoints,
  paid-start holds, the node's last error and its result landings.
- handoff-reopen NIT-1: mutants H7 and H13.
- drops-copy-ui LOW-1, LOW-2: copy names fit 120 code points, and every
  character matches the same on both sides.
- drops-copy-ui NIT-2: one rule for "also" in the tab-only note.
"""
from __future__ import annotations

import asyncio
import json
import random
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main as main_module  # noqa: E402
from services import project_store as store_module  # noqa: E402
from services.node_errors import NodeErrors  # noqa: E402
from services.node_result_runs import NodeResultRuns  # noqa: E402
from services.provider_recovery import ProviderRecoveryStore  # noqa: E402
from services import selection_context  # noqa: E402
from models.events import ExecutedEvent  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _add_text, _create, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix12 import CODEX  # noqa: E402
from tests.test_project_catalog_restore_fix16 import _node  # noqa: E402
from tests.test_project_catalog_restore_fix17 import (  # noqa: E402
    DUP, _agent_read_and_listing, _export_ids, _on_disk, _open, _rev, _stored, _value)
from tests.test_project_catalog_restore_fix18 import _boot, _handoff, _legacy_state, _live  # noqa: E402

CASES = json.loads((Path(__file__).resolve().parent / "data" / "copy_name_cases.json").read_text(encoding="utf-8"))
WINDOW_A, WINDOW_B = "tab-r20-window-a", "tab-r20-window-b"
TAB_A = {**PERSON, "X-Nebula-Tab": WINDOW_A}
TAB_B = {**PERSON, "X-Nebula-Tab": WINDOW_B}


@pytest.fixture(autouse=True)
def _fresh_books(monkeypatch):
    monkeypatch.setattr(main_module, "node_result_runs", NodeResultRuns(), raising=False)
    monkeypatch.setattr(main_module, "node_errors", NodeErrors(None))


def _copy(snapshot: dict) -> dict:
    return json.loads(json.dumps(snapshot))


def _save(client, project_id: str, snapshot: dict, headers=TAB_A) -> None:
    saved = client.put(f"/api/projects/{project_id}", headers=headers,
                       json={"workspaceRevision": _rev(client), "snapshot": snapshot})
    assert saved.status_code == 200, saved.text


def _delta(client, *, headers=TAB_A, value: str = "dup-old") -> tuple[str, dict, dict]:
    """Delta (n1 "delta-1") with a duplicate (DUP) window A autosaved.
    Returns (delta, window A's snapshot, window B's: n1 only)."""
    delta = _create(client, "Delta")
    _add_text(client, "delta-1")
    window_b = _stored(client, delta)
    window_a = _copy(window_b)
    window_a["nodes"].append(_node(DUP, "text-input", {"value": value}, 300))
    _save(client, delta, window_a, headers)
    return delta, window_a, window_b


def _agent(client) -> dict:
    return {**CODEX, "X-Nebula-Workspace-Revision": _rev(client)}


def _events(kind: str, since: int) -> list[dict]:
    return [event for event in main_module.canvas_events.read(after=since, limit=100)["events"]
            if event["kind"] == kind]


def _disk_ids(store, project_id: str) -> list[str]:
    return sorted(node["id"] for node in _on_disk(store, project_id)["snapshot"]["nodes"])


def _disk_node(store, project_id: str, node_id: str) -> dict:
    return next(node for node in _on_disk(store, project_id)["snapshot"]["nodes"] if node["id"] == node_id)


def _moved_n1(snapshot: dict) -> dict:
    moved = _copy(snapshot)
    next(node for node in moved["nodes"] if node["id"] == "n1")["position"]["x"] += 30
    return moved


def _text(value: str) -> dict:
    return {"text": {"type": "Text", "value": value}}


def _with_result(snapshot: dict, node_id: str, **data) -> dict:
    changed = _copy(snapshot)
    next(node for node in changed["nodes"] if node["id"] == node_id)["data"].update(data)
    return changed


def _record(run_id: str, node_id: str, outputs: dict, *, started: float, took: float = 1.0) -> dict:
    return {"id": run_id, "trigger": "node", "startedAt": started, "status": "complete",
            "snapshot": {"nodes": [], "edges": []}, "targetNodeId": node_id, "durationSec": took,
            "resultOutputs": {node_id: outputs}}


def _syncs() -> list[dict]:
    return [call.args[0] for call in main_module.manager.broadcast_raw.call_args_list
            if call.args and call.args[0].get("type") == "graphSync"]


# -- MEDIUM-1: a delete is said, by the window that saved the node ------------------------------

def test_m1_another_windows_handoff_keeps_the_duplicate_and_the_agents_edit(app):
    """The reviewer's probe: window B never had the duplicate; its handoff
    (n1 moved) leaves it out. n2 and the agent's edit stay, live and on
    disk, and nothing is journaled as the person's delete."""
    client, store, *_ = app
    delta, _window_a, window_b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    assert client.put(f"/api/graph/node/{new}", headers=_agent(client),
                      json={"params": {"value": "agent wrote on n2"}}).status_code == 200
    since = main_module.canvas_events.latest
    answer = _handoff(client, delta, old_rev, _moved_n1(window_b), headers=TAB_B)
    assert answer.status_code == 200 and answer.json()["handoff"] is True, answer.text
    assert sorted(_export_ids(client)) == ["n1", new]
    assert _live(client)[new]["data"]["params"]["value"] == "agent wrote on n2"
    assert _disk_ids(store, delta) == ["n1", new]  # right after the handoff, before any read
    assert not _events("node.removed", since)
    _agent_read_and_listing(client, delta)
    assert _value(_on_disk(store, delta)["snapshot"], new) == "agent wrote on n2"


@pytest.mark.parametrize("by", ["old", "new"])
def test_m1_a_delete_another_window_says_is_ignored(app, by):
    """Window B lists the duplicate as deleted though window A saved it:
    ignored, not refused. The rest of B's save lands, the node stays."""
    client, store, *_ = app
    delta, _window_a, window_b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    since = main_module.canvas_events.latest
    answer = _handoff(client, delta, old_rev, _moved_n1(window_b), headers=TAB_B,
                      deletedNodeIds=[DUP if by == "old" else new])
    assert answer.status_code == 200, answer.text
    assert sorted(_export_ids(client)) == ["n1", new]
    assert _disk_ids(store, delta) == ["n1", new]
    assert not _events("node.removed", since)


@pytest.mark.parametrize("by", ["old", "new"])
def test_m1_the_window_that_saved_it_deletes_it_by_either_id(app, by):
    """Window A deletes its duplicate and says so. Gone live, from the
    stored copy right after the handoff (mutant H7: a deleted node put back
    from the stored copy, repaired by a later read), and journaled as the
    person's delete of n2."""
    client, store, *_ = app
    delta, window_a, _window_b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    since = main_module.canvas_events.latest
    held = _copy(window_a)
    held["nodes"] = [node for node in held["nodes"] if node["id"] != DUP]
    answer = _handoff(client, delta, old_rev, held, headers=TAB_A, deletedNodeIds=[DUP if by == "old" else new])
    assert answer.status_code == 200, answer.text
    assert _export_ids(client) == ["n1"]
    assert _disk_ids(store, delta) == ["n1"]
    removed = _events("node.removed", since)
    assert [(event["nodeId"], event["actor"]["kind"]) for event in removed] == [(new, "person")]
    assert [node["id"] for node in _stored(client, delta)["nodes"]] == ["n1"]


def test_m1_its_own_window_leaving_it_out_without_saying_so_deletes_nothing(app):
    client, store, *_ = app
    delta, window_a, _window_b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    held = _copy(window_a)
    held["nodes"] = [node for node in held["nodes"] if node["id"] != DUP]
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert sorted(_export_ids(client)) == ["n1", new]
    assert _disk_ids(store, delta) == ["n1", new]


def test_m1_a_delete_listed_while_the_tab_still_holds_the_node_deletes_nothing(app):
    client, store, *_ = app
    delta, window_a, _window_b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    assert _handoff(client, delta, old_rev, window_a, headers=TAB_A, deletedNodeIds=[DUP]).status_code == 200
    assert sorted(_export_ids(client)) == ["n1", new]
    assert _disk_ids(store, delta) == ["n1", new]


def test_m1_a_delete_by_a_save_with_no_window_deletes_nothing(app):
    """The person's token without X-Nebula-Tab (no window) can't say it."""
    client, store, *_ = app
    delta, window_a, _window_b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    held = _copy(window_a)
    held["nodes"] = [node for node in held["nodes"] if node["id"] != DUP]
    assert _handoff(client, delta, old_rev, held, headers=PERSON, deletedNodeIds=[DUP]).status_code == 200
    assert sorted(_export_ids(client)) == ["n1", new]


def test_m1_which_window_saved_each_tab_local_node_is_kept_and_follows_the_renumber(app):
    client, store, *_ = app
    delta, window_a, _window_b = _delta(client)
    assert _on_disk(store, delta)[main_module._TAB_LOCAL_WRITERS] == {DUP: WINDOW_A}
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    assert _on_disk(store, delta)[main_module._TAB_LOCAL_WRITERS] == {new: WINDOW_A}


def test_m1_a_save_without_a_window_records_no_writer(app):
    client, store, *_ = app
    delta, window_a, _window_b = _delta(client)
    _save(client, delta, window_a, headers=PERSON)
    assert main_module._TAB_LOCAL_WRITERS not in _on_disk(store, delta)


@pytest.mark.parametrize("listed", ["not a list", [1], [""]])
def test_m1_a_malformed_delete_list_refuses_the_handoff(app, listed):
    client, store, *_ = app
    delta, window_a, _window_b = _delta(client)
    old_rev = _rev(client)
    _open(client, delta, headers=CODEX)
    answer = _handoff(client, delta, old_rev, window_a, headers=TAB_A, deletedNodeIds=listed)
    assert answer.status_code == 409, answer.text


def test_m1_after_an_agents_switch_away_another_windows_handoff_keeps_the_duplicate(app):
    """The duplicate was never on Nebula's graph (the agent opened another
    project): window B's handoff leaves it out because it never had it."""
    client, store, *_ = app
    other = _create(client, "Other")
    delta, _window_a, window_b = _delta(client)
    old_rev = _rev(client)
    assert _open(client, other, headers=CODEX).status_code == 200
    assert _handoff(client, delta, old_rev, _moved_n1(window_b), headers=TAB_B).status_code == 200
    assert _disk_ids(store, delta) == sorted(["n1", DUP])
    assert _on_disk(store, delta)[main_module._TAB_LOCAL_WRITERS] == {DUP: WINDOW_A}


def test_m1_after_an_agents_switch_away_its_own_windows_handoff_without_it_drops_it(app):
    """A node only window A ever had: A's own save is still its whole copy
    of it (the ordinary rule), as before this round."""
    client, store, *_ = app
    other = _create(client, "Other")
    delta, window_a, _window_b = _delta(client)
    old_rev = _rev(client)
    assert _open(client, other, headers=CODEX).status_code == 200
    held = _copy(window_a)
    held["nodes"] = [node for node in held["nodes"] if node["id"] != DUP]
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert _disk_ids(store, delta) == ["n1"]


# -- NIT-1, mutant H13: a node World Labs paid state holds isn't deleted -----------------------

def test_h13_a_deleted_duplicate_a_world_labs_checkpoint_holds_stays_live(app, tmp_path, monkeypatch):
    client, store, *_ = app
    recoveries = ProviderRecoveryStore(tmp_path / "provider-recoveries.json")
    monkeypatch.setattr(main_module, "provider_recovery_store", recoveries)
    delta, window_a, _window_b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    # A checkpoint for n2 after the open (the open refuses while one exists).
    recoveries.set(run_id="wl-run-h13", node_id=new, resume_operation_id="op-h13", existing_world_id=None)
    since = main_module.canvas_events.latest
    held = _copy(window_a)
    held["nodes"] = [node for node in held["nodes"] if node["id"] != DUP]
    assert _handoff(client, delta, old_rev, held, headers=TAB_A, deletedNodeIds=[DUP]).status_code == 200
    assert sorted(_export_ids(client)) == ["n1", new]
    assert not _events("node.removed", since)
    # The next read lays the live node over the stored copy: it is back.
    assert sorted(node["id"] for node in _stored(client, delta)["nodes"]) == ["n1", new]


# -- MEDIUM-3: run results move as one unit; the newer run wins -----------------------------

def test_m3_the_reviewers_probe_a_result_on_the_duplicate_survives_an_agents_reopen(app):
    client, store, *_ = app
    delta, window_a, _window_b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    held = _with_result(window_a, DUP, outputs=_text("RAN-RESULT"), state="complete", runNotes=["ran"])
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    stored = _disk_node(store, delta, new)["data"]
    assert stored["outputs"] == _text("RAN-RESULT") and stored["state"] == "complete" and stored["runNotes"] == ["ran"]
    assert _live(client)[new]["data"]["outputs"]["text"]["value"] == "RAN-RESULT"
    loaded = next(node for node in _stored(client, delta)["nodes"] if node["id"] == new)["data"]
    assert loaded["outputs"]["text"]["value"] == "RAN-RESULT" and loaded["runNotes"] == ["ran"]


def test_m3_a_result_on_n1_survives_an_agents_switch_away(app):
    """Not only renumbered nodes: n1's result from the tab's run (its run
    record says so) lands whole, its notes too."""
    client, store, *_ = app
    other = _create(client, "Other")
    delta, window_a, _window_b = _delta(client)
    old_rev = _rev(client)
    assert _open(client, other, headers=CODEX).status_code == 200
    held = _with_result(window_a, "n1", outputs=_text("N1-RAN"), state="complete", runNotes=["n1 ran"])
    held["runHistory"] = [_record("run-n1", "n1", _text("N1-RAN"), started=time.time() * 1000)]
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    stored = _disk_node(store, delta, "n1")["data"]
    assert stored["outputs"] == _text("N1-RAN") and stored["runNotes"] == ["n1 ran"]


def test_m3_a_result_on_n1_goes_live_after_an_agents_reopen(app):
    client, store, *_ = app
    delta, window_a, _window_b = _delta(client)
    old_rev = _rev(client)
    assert _open(client, delta, headers=CODEX).status_code == 200
    held = _with_result(window_a, "n1", outputs=_text("N1-RAN"), state="complete")
    held["runHistory"] = [_record("run-n1", "n1", _text("N1-RAN"), started=time.time() * 1000)]
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert _live(client)["n1"]["data"]["outputs"] == _text("N1-RAN")


def test_m3_a_result_with_no_run_record_never_stands_over_nebulas(app):
    """n1 isn't renumbered (no baseline): a differing result the tab's run
    history doesn't back keeps the stored one."""
    client, store, *_ = app
    other = _create(client, "Other")
    delta, window_a, _window_b = _delta(client)
    old_rev = _rev(client)
    assert _open(client, other, headers=CODEX).status_code == 200
    held = _with_result(window_a, "n1", outputs=_text("NO-RECORD"), state="complete")
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert _disk_node(store, delta, "n1")["data"]["outputs"] == {}


def test_m3_an_agents_later_run_of_n2_stands_over_the_tabs_older_result(app):
    """Nebula saw the tab's run land on the duplicate before the open, and
    the agent's run of n2 land after it: the agent's is newer."""
    client, store, *_ = app
    delta, window_a, _window_b = _delta(client)
    main_module.node_result_runs.landed(delta, DUP, "tab-run")
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    main_module.cli_graph.nodes[new]["outputs"] = _text("AGENT")
    main_module.node_result_runs.landed(delta, new, "agent-run")
    held = _with_result(window_a, DUP, outputs=_text("TAB-OLD"), state="complete")
    held["runHistory"] = [_record("tab-run", DUP, _text("TAB-OLD"), started=time.time() * 1000)]
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert _live(client)[new]["data"]["outputs"] == _text("AGENT")
    loaded = next(node for node in _stored(client, delta)["nodes"] if node["id"] == new)["data"]
    assert loaded["outputs"] == _text("AGENT")


def test_m3_the_tabs_newer_run_wins_over_an_older_landing(app):
    """Nebula didn't see the tab's run (a restart): its record finished
    after the agent's result landed, so the tab's stands."""
    client, store, *_ = app
    delta, window_a, _window_b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    now = time.time() * 1000
    main_module.cli_graph.nodes[new]["outputs"] = _text("AGENT")
    main_module.node_result_runs.landed(delta, new, "agent-run", at=now - 60_000)
    held = _with_result(window_a, DUP, outputs=_text("TAB-NEW"), state="complete")
    held["runHistory"] = [_record("tab-run", DUP, _text("TAB-NEW"), started=now - 1_000)]
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert _live(client)[new]["data"]["outputs"] == _text("TAB-NEW")
    assert _disk_node(store, delta, new)["data"]["outputs"] == _text("TAB-NEW")


def test_m3_the_tabs_older_record_loses_to_a_later_landing(app):
    client, store, *_ = app
    delta, window_a, _window_b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    now = time.time() * 1000
    main_module.cli_graph.nodes[new]["outputs"] = _text("AGENT")
    main_module.node_result_runs.landed(delta, new, "agent-run", at=now)
    held = _with_result(window_a, DUP, outputs=_text("TAB-OLD"), state="complete")
    held["runHistory"] = [_record("tab-run", DUP, _text("TAB-OLD"), started=now - 60_000)]
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert _live(client)[new]["data"]["outputs"] == _text("AGENT")


def test_m3_the_tabs_result_as_the_open_loaded_it_never_stands_over_an_agents_run(app):
    client, store, *_ = app
    delta, window_a, _window_b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    main_module.cli_graph.nodes[new]["outputs"] = _text("AGENT")
    main_module.node_result_runs.landed(delta, new, "agent-run")
    assert _handoff(client, delta, old_rev, _moved_n1(window_a), headers=TAB_A).status_code == 200
    assert _live(client)[new]["data"]["outputs"] == _text("AGENT")


def test_m3_only_the_persons_window_hands_a_result_over(app):
    client, store, *_ = app
    delta, window_a, _window_b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    held = _with_result(window_a, DUP, outputs=_text("NOT-THE-PERSONS"), state="complete")
    assert _handoff(client, delta, old_rev, held, headers=CODEX).status_code == 200
    assert _disk_node(store, delta, new)["data"]["outputs"] == {}


def test_m3_a_failure_on_the_duplicate_reaches_its_error_record(app):
    client, store, *_ = app
    delta, window_a, _window_b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    held = _with_result(window_a, DUP, state="error", error="boom", errorCategory="unknown")
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert main_module.node_errors.get(new) == {"error": "boom"}
    assert _live(client)[new]["data"]["state"] == "error"


def test_m3_the_baseline_moves_on_to_the_tabs_result(app):
    """A later handoff with the same result is the one the baseline holds:
    an agent's run since then stands, whatever the clocks say (its landing
    is stamped before the tab's record finished)."""
    client, store, *_ = app
    delta, window_a, _window_b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    now = time.time() * 1000
    held = _with_result(window_a, DUP, outputs=_text("TAB"), state="complete")
    held["runHistory"] = [_record("tab-run", DUP, _text("TAB"), started=now - 60_000)]
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert _live(client)[new]["data"]["outputs"] == _text("TAB")
    main_module.cli_graph.nodes[new]["outputs"] = _text("AGENT")
    main_module.node_result_runs.landed(delta, new, "agent-run", at=now - 120_000)
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert _live(client)[new]["data"]["outputs"] == _text("AGENT")


def test_m3_a_result_without_a_failure_forgets_the_nodes_old_error(app):
    client, store, *_ = app
    delta, window_a, _window_b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    main_module.node_errors.record(new, "old boom")
    held = _with_result(window_a, DUP, outputs=_text("FIXED"), state="complete")
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert main_module.node_errors.get(new) is None


def test_m3_nebula_notes_each_result_landing_in_the_runs_project(app, monkeypatch):
    client, store, *_ = app
    delta = _create(client, "Delta")
    _add_text(client, "delta-1")

    async def _quiet(*_args, **_kwargs):
        return None

    monkeypatch.setattr(main_module.manager, "broadcast", _quiet)
    asyncio.run(main_module._emit_and_sync(ExecutedEvent(node_id="n1", outputs=_text("ran"), run_id="run-hook")))
    assert [entry["runId"] for entry in main_module.node_result_runs.entries(delta, "n1")] == ["run-hook"]


# -- LOW-1: the person's reopen in place, other windows follow -----------------------------------

def test_l1_the_persons_reopen_in_place_tells_other_windows_to_follow(app):
    client, store, *_ = app
    delta, _window_a, _window_b = _delta(client)
    old_rev = _rev(client)
    main_module.manager.broadcast_raw.reset_mock()
    opened = _open(client, delta, headers=TAB_A)
    assert opened.status_code == 200, opened.text
    assert _syncs()[0]["projectSwitch"] == {
        "actor": {"kind": "person", "tab": WINDOW_A}, "previousProjectId": delta, "previousProjectName": "Delta",
        "previousRevision": old_rev, "projectId": delta, "projectName": "Delta", "created": False}
    assert store_module.ProjectStore(store.root).read()["handoffs"] == {delta: old_rev}


def test_l1_window_bs_typing_lands_after_window_as_reopen_in_place(app):
    client, store, *_ = app
    delta, _window_a, window_b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=TAB_A).json()["renumbered"][DUP]
    typed = _copy(window_b)
    next(node for node in typed["nodes"] if node["id"] == "n1")["data"]["params"]["value"] = "b typed late"
    answer = _handoff(client, delta, old_rev, typed, headers=TAB_B, pendingParams={"n1": {"value": "b typed late"}})
    assert answer.status_code == 200 and answer.json()["handoff"] is True, answer.text
    assert _live(client)["n1"]["data"]["params"]["value"] == "b typed late"
    assert sorted(_export_ids(client)) == ["n1", new]  # B never had the duplicate
    _agent_read_and_listing(client, delta)
    assert _value(_on_disk(store, delta)["snapshot"], "n1") == "b typed late"


def test_l1_the_persons_open_of_another_project_still_ends_every_handoff(app):
    client, store, *_ = app
    other = _create(client, "Other")
    delta, _window_a, _window_b = _delta(client)
    assert _open(client, other, headers=CODEX).status_code == 200
    assert _open(client, delta, headers=TAB_A).status_code == 200
    assert "handoffs" not in store_module.ProjectStore(store.root).read()


# -- LOW-2: per-node records follow a renumber --------------------------------------------------

def test_l2_a_world_labs_checkpoint_and_hold_follow_the_boot_renumber(app, tmp_path, monkeypatch):
    """Recover after the renumber finds the checkpoint by the node's new id:
    Run History's list, the node's guard, and Forget ID."""
    client, store, _graph, state = app
    recoveries = ProviderRecoveryStore(tmp_path / "provider-recoveries.json")
    monkeypatch.setattr(main_module, "provider_recovery_store", recoveries)
    delta = _legacy_state(client, store, state, live_value="dup", project_value="dup")
    recoveries.set(run_id="wl-run-r20", node_id=DUP, resume_operation_id="op-r20", existing_world_id=None)
    main_module.provider_start_guard.mark_ambiguous(run_id="wl-run-r20b", node_id=DUP, kind="worldlabs-environment")
    _boot(state)
    new = main_module._boot_renumbered[DUP]
    assert recoveries.list() == [{"runId": "wl-run-r20", "nodeId": new, "resumeOperationId": "op-r20",
                                  "existingWorldId": None}]
    assert [(hold["runId"], hold["nodeId"]) for hold in main_module.provider_start_guard.list()] == [
        ("wl-run-r20b", new)]
    exported = client.get("/api/graph/export", headers=PERSON).json()
    assert [record["nodeId"] for record in exported["providerRecoveries"]] == [new]
    refused = client.delete(f"/api/graph/node/{new}", headers={**PERSON, "X-Nebula-Workspace-Revision": _rev(client)})
    assert refused.status_code == 409, refused.text
    forgot = client.delete(f"/api/provider-recoveries/wl-run-r20/{new}?resume_operation_id=op-r20", headers=PERSON)
    assert forgot.status_code == 200, forgot.text
    assert recoveries.list() == []
    assert delta


def test_l2_a_nodes_last_error_and_result_landings_follow_an_open_renumber(app):
    client, store, *_ = app
    delta, _window_a, _window_b = _delta(client)
    main_module.node_errors.use_project(delta)
    main_module.node_errors.record(DUP, "boom")
    main_module.node_result_runs.landed(delta, DUP, "run-before")
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    assert main_module.node_errors.get(new) == {"error": "boom"} and main_module.node_errors.get(DUP) is None
    assert [entry["runId"] for entry in main_module.node_result_runs.entries(delta, new)] == ["run-before"]
    assert main_module.node_result_runs.entries(delta, DUP) == []


# -- drops-copy-ui LOW-1, LOW-2: names fit; every character agrees -------------------------------

def test_names_every_shared_case_is_a_valid_name_of_at_most_120_code_points():
    long_cases = [case for case in CASES if len(case["source"]) > 100]
    assert len(long_cases) >= 8
    assert any(" " in case["source"] for case in CASES) and any(" " in case["source"] for case in CASES)
    for case in CASES:
        assert len(case["expect"]) <= store_module.NAME_LIMIT
        assert store_module.project_name(case["expect"]) == case["expect"]


def _fuzz_atoms() -> list[str]:
    return ["Shot", "7", "Alpha", "copy", "copy 2", "copy 10", "copy 1", "copy 01", "Recovered", "canvas",
            "(recovered)", "(recovered 2)", "Take2", "٧", "７", "2", "10", " ", " ", " ",
            "\U0001F3AC", "é", "x" * 60, "Delta"]


def test_names_the_reviewers_fuzz_every_copy_name_is_free_and_valid():
    """The review's differential fuzz, kept as a property test (the tab's
    side checks the same names against the shared cases)."""
    rng = random.Random(1899)
    atoms = _fuzz_atoms()

    def name() -> str:
        # A project's name as Nebula keeps it (project_name strips it).
        return " ".join(rng.choice(atoms) for _ in range(rng.randint(1, 4))).strip() or "x"

    for _ in range(400):
        source = name()
        for family in ("copy", "recovered"):
            names = [source]
            for _ in range(rng.randint(0, 3)):
                listed = {"projects": {str(i): {"name": n} for i, n in enumerate(names)}, "trash": {}}
                names.append(store_module.duplicate_name(source, listed) if family == "copy"
                             else store_module.recovered_name(source, listed))
            listed = {"projects": {str(i): {"name": n} for i, n in enumerate(names)}, "trash": {}}
            got = (store_module.duplicate_name(source, listed) if family == "copy"
                   else store_module.recovered_name(source, listed))
            assert got not in names
            assert store_module.project_name(got) == got and len(got) <= store_module.NAME_LIMIT


def test_names_the_cut_drops_exactly_the_spaces_a_name_cant_end_in():
    """CUT_SPACES is every character str.strip() removes that a name can
    hold, so a cut stem never ends in one (the frontend uses the same set)."""
    stripped = {chr(code) for code in range(0x20, 0x110000) if chr(code).isspace()}
    assert set(store_module.CUT_SPACES) == stripped
    for space in store_module.CUT_SPACES:
        source = "a" * 114 + space + "b" * 5
        got = store_module.duplicate_name(source, {"projects": {}, "trash": {}})
        assert got == "a" * 114 + " copy" and store_module.project_name(got) == got
        recovered = store_module.recovered_name("c" * 109 + space + "d" * 5, {"projects": {}, "trash": {}})
        assert recovered == "Recovered " + "c" * 109


def test_names_a_long_name_copied_again_and_again_stays_whole_and_free():
    names = ["L" * 120]
    for _ in range(25):
        listed = {"projects": {str(i): {"name": n} for i, n in enumerate(names)}, "trash": {}}
        names.append(store_module.duplicate_name(names[-1], listed))
    assert len(set(names)) == len(names) and all(len(n) <= 120 for n in names)
    assert names[-1].endswith(" copy 25")


def test_names_the_recover_answer_keeps_a_long_source_name_whole(app):
    client, store, *_ = app
    _create(client, "Alpha")
    shown = "L" * 120
    body = {"recoveryId": "d" * 32, "sourceProjectId": "e" * 32, "sourceName": shown,
            "snapshot": {"nodes": [], "edges": []}}
    answer = client.post("/api/projects/recover", json=body, headers=PERSON)
    assert answer.status_code == 200, answer.text
    assert answer.json()["sourceName"] == shown
    assert answer.json()["project"]["name"] == "Recovered " + "L" * 110


# -- drops-copy-ui NIT-2: one rule for "also" ---------------------------------------------------

@pytest.mark.parametrize("visible", [True, False])
def test_the_read_and_the_prompt_say_also_by_one_rule(visible):
    read = {"selectedNodeIds": ["n1"] if visible else [], "count": int(visible), "missingNodeIds": [],
            "nodes": [] if visible else [{"id": "n9", "displayName": "X", "definitionId": "text-input"}],
            "connections": [], "tabOnlyCount": 2}
    line = selection_context.selection_tab_only_note(read)
    assert line == selection_context.tab_only_note(2, also=visible)
    assert f"- {line}" in selection_context.selection_prompt_context(read).splitlines()
