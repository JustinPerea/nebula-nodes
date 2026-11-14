"""PR #199 fix round 23, 2a: the World Labs delete guard rests on a stamp
Nebula writes (review 21 LOW-1; Justin's answer: stamp at write, histories
only add holds; the coordinator's two calls: a stamp naming a project
deleted for good still holds, and the one-time startup stamp places by run
history only).

When Nebula writes a recovery record it stamps it with the project whose
canvas the run is on, and the node's type. Only that stamp releases a node:
a record holds unless its stamp names another project that still exists,
and even then the signs that only add a hold (the run registered on the
open project, in its stored history, or its stored node holding the ID)
keep it. The stamp is internal: agents' reads stay as they were; the
person's tab gets the places through its own channels.
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import time
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main as main_module  # noqa: E402
from services.provider_recovery import ProviderRecoveryStore  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _add_text, _create, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix12 import CODEX  # noqa: E402
from tests.test_project_catalog_restore_fix16 import _node  # noqa: E402
from tests.test_project_catalog_restore_fix17 import DUP, _autosave, _open, _rev, _stored  # noqa: E402
from tests.test_project_catalog_restore_fix18 import TAB, _handoff, _held  # noqa: E402
from tests.test_project_catalog_restore_fix20_review18 import _record  # noqa: E402
from tests.test_project_catalog_restore_fix21 import (  # noqa: E402,F401
    ENVIRONMENT, _alpha_then_delta, _named, _with_run, recoveries)

EXPORT = "worldlabs-world-export"
OWN_LINE = "“Delta brief” has a saved World Labs recovery ID. Check the run in Marble, then forget the ID in Run History."
SHARED = ("Nebula couldn’t delete “Delta brief” because it shares the ID n1 with a World Labs run from a project "
          "Nebula can’t identify. Check that run in Marble before you forget its ID in Run History, then try again.")
UNPLACED = ("Nebula couldn’t delete “Delta brief” because it has a saved World Labs recovery ID. "
            "Check the run in Marble, then forget that ID in Run History.")
AGENT_DETAIL = ("Cannot delete n1: it has unresolved World Labs paid state. "
                "Check Marble, then resolve its exact recovery/ambiguity record first.")


def _delete(client, headers=PERSON, node_id="n1"):
    return client.request("DELETE", f"/api/graph/node/{node_id}",
                          headers={**headers, "X-Nebula-Workspace-Revision": _rev(client)})


def _set(recoveries, run_id, *, project=None, node_type=None, op="op-1", world=None, node_id="n1"):
    recoveries.set(run_id=run_id, node_id=node_id, resume_operation_id=None if world else op,
                   existing_world_id=world, project_id=project, node_type=node_type)


def _delta_brief(client):
    alpha, delta = _alpha_then_delta(client)
    _named("Delta brief")
    return alpha, delta


def _refused(client, line, *, agent_too=True):
    refused = _delete(client)
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"] == line
    assert "n1" in main_module.cli_graph.nodes
    if agent_too:
        agent = _delete(client, CODEX)
        assert agent.status_code == 409, agent.text
        assert agent.json()["detail"] == AGENT_DETAIL


def _duplicate(store, project_id, name):
    with store.transaction() as catalog:
        source = catalog["projects"][project_id]
        twin = uuid.uuid4().hex
        catalog["projects"][twin] = json.loads(json.dumps({**source, "id": twin, "name": name}))
        store.commit(catalog)
    return twin


# -- 1. Review 21's two repros now answer 409 -----------------------------------------------------

@pytest.mark.parametrize("stamped", [True, False], ids=["stamped", "legacy-unstamped"])
def test_an_agent_forging_another_projects_history_cant_release_the_open_projects_record(app, recoveries, stamped):
    """RD probe_place.py::test_agent_forges_another_project: a copy whose run
    history names Delta's run (POST /recover), then an autosave of Delta
    without it. On 77209c27 the agent's delete answered 200."""
    client, _store, *_ = app
    _alpha, delta = _delta_brief(client)
    _set(recoveries, "wl-run-delta", project=delta if stamped else None)
    assert _delete(client, CODEX).status_code == 409
    forged = {"nodes": [], "edges": [], "runHistory": [_record("wl-run-delta", "n1", {}, started=time.time() * 1000)]}
    made = client.post("/api/projects/recover", headers=CODEX, json={
        "sourceProjectId": delta, "snapshot": forged, "recoveryId": uuid.uuid4().hex,
        "paramsVersion": main_module.PARAMS_VERSION, "sourceName": "Delta"})
    assert made.status_code == 200, made.text
    snap = _stored(client, delta)
    snap["runHistory"] = []
    saved = client.put(f"/api/projects/{delta}", headers=CODEX, json={"workspaceRevision": _rev(client), "snapshot": snap})
    assert saved.status_code == 200, saved.text
    agent = _delete(client, CODEX)
    assert agent.status_code == 409, agent.text
    assert agent.json()["detail"] == AGENT_DETAIL
    assert "n1" in main_module.cli_graph.nodes
    assert [r["runId"] for r in recoveries.list()] == ["wl-run-delta"]


@pytest.mark.parametrize("stamped", [True, False], ids=["stamped", "legacy-unstamped"])
def test_the_open_projects_run_capped_out_while_a_copy_holds_it_still_refuses(app, recoveries, stamped):
    """RD probe_place.py::test_open_projects_run_capped_out_with_a_copy:
    Delta duplicated, then Delta's history loses the run. On 77209c27 the
    person's delete answered 200."""
    client, store, *_ = app
    _alpha, delta = _delta_brief(client)
    _duplicate(store, delta, "Delta copy")
    _set(recoveries, "wl-run-delta", project=delta if stamped else None)
    assert _delete(client).status_code == 409
    snap = _stored(client, delta)
    snap["runHistory"] = [_record(f"later-{i}", "n1", {}, started=time.time() * 1000 + i) for i in range(3)]
    saved = client.put(f"/api/projects/{delta}", headers=PERSON, json={"workspaceRevision": _rev(client), "snapshot": snap})
    assert saved.status_code == 200, saved.text
    refused = _delete(client)
    assert refused.status_code == 409, refused.text
    # Stamped with Delta: its own line. Unstamped: its run is only in the
    # copy's history now, so whose can't be told: GM r36's line.
    assert refused.json()["detail"] == (OWN_LINE if stamped else SHARED)
    assert _delete(client, CODEX).json()["detail"] == AGENT_DETAIL


# -- 2. Only the stamp releases ---------------------------------------------------------------

@pytest.mark.parametrize("who", [PERSON, CODEX], ids=["person", "agent"])
def test_lr1_deltas_n1_deletes_against_alphas_stamped_record(app, recoveries, who):
    client, *_ = app
    alpha, _delta = _delta_brief(client)
    _set(recoveries, "wl-run-alpha", project=alpha)
    deleted = _delete(client, who)
    assert deleted.status_code == 200, deleted.text
    assert "n1" not in main_module.cli_graph.nodes
    assert [r["runId"] for r in recoveries.list()] == ["wl-run-alpha"]


def test_a_stamp_releases_in_recently_deleted_too(app, recoveries):
    client, store, *_ = app
    alpha, _delta = _delta_brief(client)
    with store.transaction() as catalog:
        entry = catalog["projects"].pop(alpha)
        entry["deletedAt"] = "2026-10-31T00:00:00+00:00"
        catalog.setdefault("trash", {})[alpha] = entry
        store.commit(catalog)
    _set(recoveries, "wl-run-alpha", project=alpha)
    assert _delete(client).status_code == 200


def test_an_unstamped_record_placed_in_alpha_by_history_holds(app, recoveries):
    """The fail-open row of review 21's table: history placement may only add holds."""
    client, *_ = app
    _delta_brief(client)
    _set(recoveries, "wl-run-alpha")
    _refused(client, SHARED)


def test_an_unstamped_ambiguous_record_holds(app, recoveries):
    client, store, *_ = app
    alpha, _delta = _delta_brief(client)
    _duplicate(store, alpha, "Beta")  # the run is in Alpha's and Beta's histories
    _set(recoveries, "wl-run-alpha")
    _refused(client, SHARED)


def test_a_stamp_naming_a_project_deleted_for_good_holds_with_the_shared_line(app, recoveries):
    """The coordinator's call 1: review 21's "deleted for good -> 409" row stays 409."""
    client, store, *_ = app
    alpha, _delta = _delta_brief(client)
    with store.transaction() as catalog:
        catalog["projects"].pop(alpha)
        store.commit(catalog)
    _set(recoveries, "wl-run-alpha", project=alpha)
    _refused(client, SHARED)


def test_a_stamp_naming_the_open_project_holds_even_with_its_run_only_in_another_history(app, recoveries):
    client, store, *_ = app
    _alpha, delta = _delta_brief(client)
    _set(recoveries, "wl-run-alpha", project=delta)
    _refused(client, OWN_LINE)


@pytest.mark.parametrize("sign", ["registered", "history"])
def test_signs_that_only_add_a_hold_keep_a_record_stamped_elsewhere(app, recoveries, monkeypatch, sign):
    client, store, *_ = app
    alpha, delta = _delta_brief(client)
    if sign == "registered":
        class Run:
            canvas = (delta, "rev")
        real = main_module.execution_runs.get
        monkeypatch.setattr(main_module.execution_runs, "get",
                            lambda run_id: Run() if run_id == "wl-run-alpha" else real(run_id))
    else:
        with store.transaction() as catalog:
            history = catalog["projects"][delta]["snapshot"].setdefault("runHistory", [])
            history.append(_record("wl-run-alpha", "n1", {}, started=time.time() * 1000))
            store.commit(catalog)
    _set(recoveries, "wl-run-alpha", project=alpha)
    _refused(client, OWN_LINE)


def test_the_open_projects_stored_node_holding_the_id_adds_a_hold():
    """The third sign, on the stored copy itself (the open project's copy is
    rewritten from the live canvas at each save, whose node is checked first)."""
    def catalog(params):
        node = {"id": "n1", "data": {"definitionId": ENVIRONMENT, "params": params}}
        return {"activeProjectId": "delta", "projects": {"delta": {"id": "delta", "snapshot": {"nodes": [node]}}}}
    record = {"runId": "wl-run-alpha", "nodeId": "n1", "resumeOperationId": "op-1", "existingWorldId": None}
    assert main_module._record_may_be_open_projects(catalog({"resume_operation_id": "op-1"}), record, "delta") is True
    assert main_module._record_may_be_open_projects(catalog({"resume_operation_id": "op-2"}), record, "delta") is False
    assert main_module._record_may_be_open_projects(catalog({}), {**record, "nodeId": "n2"}, "delta") is False


def test_a_stamped_elsewhere_world_id_record_held_by_the_nodes_world_id_keeps_the_recovery_line(app, recoveries,
                                                                                                  monkeypatch):
    """RD NIT-1, M10 (`wanted` without existingWorldId): the node's own
    Existing World ID holds Alpha's record, so the line is the record's own,
    not the params line. (The signs that only add a hold are switched off:
    the open project's stored copy mirrors the live node, so its stored-node
    sign would hold it too.)"""
    monkeypatch.setattr(main_module, "_record_may_be_open_projects", lambda *_args: False)
    client, *_ = app
    alpha, _delta = _delta_brief(client)
    _set(recoveries, "wl-run-alpha", project=alpha, world="world-1")
    live = main_module.cli_graph.nodes["n1"]
    live["definitionId"] = ENVIRONMENT
    live["params"] = {**(live.get("params") or {}), "existing_world_id": "world-1"}
    _refused(client, OWN_LINE)


def test_a_run_only_in_recently_deleted_is_a_project_nebula_cant_identify(app, recoveries):
    """RD NIT-1, M15: the shared-id line counts Recently deleted; without it
    the line would wrongly say the record is placed nowhere."""
    client, store, *_ = app
    alpha, _delta = _delta_brief(client)
    with store.transaction() as catalog:
        entry = catalog["projects"].pop(alpha)
        entry["deletedAt"] = "2026-10-31T00:00:00+00:00"
        catalog.setdefault("trash", {})[alpha] = entry
        store.commit(catalog)
    _set(recoveries, "wl-run-alpha")
    _refused(client, SHARED)


def test_a_record_nothing_names_keeps_the_unplaced_line(app, recoveries):
    client, *_ = app
    _delta_brief(client)
    _set(recoveries, "wl-run-nowhere")
    _refused(client, UNPLACED)


def test_unknowns_still_fail_closed(app, recoveries, monkeypatch):
    client, *_ = app
    alpha, _delta = _delta_brief(client)
    _set(recoveries, "wl-run-alpha", project=alpha)
    record, node = recoveries.list()[0], main_module.cli_graph.nodes["n1"]
    assert main_module._recovery_record_holds_node(record, node) is False
    with monkeypatch.context() as m:
        m.setattr(main_module, "_catalog_for_the_hold", lambda: {})
        assert main_module._recovery_record_holds_node(record, node) is True
    with monkeypatch.context() as m:
        m.setattr(main_module.cli_graph, "owner", "someone-else")
        assert main_module._recovery_record_holds_node(record, node) is True

    def boom(*_args, **_kwargs):
        raise RuntimeError("boom")
    with monkeypatch.context() as m:
        m.setattr(main_module, "_stamped_project_id", boom)
        assert main_module._recovery_record_holds_node(record, node) is True


# -- 3. Stamped at write --------------------------------------------------------------------------

def test_a_runs_recovery_event_stamps_the_project_it_registered_on_and_the_live_nodes_type(app, recoveries, monkeypatch):
    client, *_ = app
    _alpha, delta = _delta_brief(client)
    live = main_module.cli_graph.nodes["n1"]
    live["definitionId"] = EXPORT

    class Run:
        canvas = (delta, "rev")
    real = main_module.execution_runs.get
    monkeypatch.setattr(main_module.execution_runs, "get", lambda run_id: Run() if run_id == "wl-run-x" else real(run_id))
    event = main_module.ProviderRecoveryEvent(node_id="n1", resume_operation_id="op-x", existing_world_id=None,
                                              run_id="wl-run-x")
    main_module._sync_provider_recovery_to_cli_graph(event)
    assert recoveries.stamp_of("wl-run-x", "n1") == {"projectId": delta, "nodeType": EXPORT}
    # A later write of the same key that knows less keeps the stamp.
    monkeypatch.setattr(main_module.execution_runs, "get", real)
    main_module._sync_provider_recovery_to_cli_graph(main_module.ProviderRecoveryEvent(
        node_id="n1", resume_operation_id=None, existing_world_id="world-x", run_id="wl-run-x"))
    assert recoveries.stamp_of("wl-run-x", "n1") == {"projectId": delta, "nodeType": EXPORT}


def test_a_recovery_runs_claim_stamps_the_open_project_and_the_nodes_type(app, recoveries, monkeypatch):
    """prepare_recovery_journal: a run resuming a node's World Labs ID
    journals it before any provider call, stamped with the open canvas's
    project (a registered run blocks a switch) and the node's definition."""
    from models.graph import GraphNode
    client, *_ = app
    _alpha, delta = _delta_brief(client)
    monkeypatch.setattr(main_module.provider_start_guard, "claim", lambda **kwargs: kwargs["pre_commit"]())
    main_module._claim_fresh_paid_worldlabs_starts(run_id="wl-run-claim", nodes=[
        GraphNode(id="n7", definitionId=EXPORT, params={"resume_operation_id": "op-claim"})])
    assert [r["runId"] for r in recoveries.list()] == ["wl-run-claim"]
    assert recoveries.stamp_of("wl-run-claim", "n7") == {"projectId": delta, "nodeType": EXPORT}


def test_a_run_on_another_canvas_writes_no_live_node_type(app, recoveries, monkeypatch):
    client, *_ = app
    alpha, _delta = _delta_brief(client)

    class Run:
        canvas = (alpha, "rev")
    real = main_module.execution_runs.get
    monkeypatch.setattr(main_module.execution_runs, "get", lambda run_id: Run() if run_id == "wl-run-y" else real(run_id))
    main_module._sync_provider_recovery_to_cli_graph(main_module.ProviderRecoveryEvent(
        node_id="n1", resume_operation_id="op-y", existing_world_id=None, run_id="wl-run-y"))
    assert recoveries.stamp_of("wl-run-y", "n1") == {"projectId": alpha, "nodeType": None}


def test_a_seed_from_a_canvas_stamps_that_canvas_project_and_each_nodes_type(app, recoveries):
    client, *_ = app
    _alpha, delta = _delta_brief(client)
    added = main_module._ensure_shared_graph_recoveries(
        [{"id": "n1", "definitionId": ENVIRONMENT, "params": {"existing_world_id": "world-s"}}],
        source="test", project_id=delta)
    assert len(added) == 1
    assert recoveries.stamp_of(added[0]["runId"], "n1") == {"projectId": delta, "nodeType": ENVIRONMENT}
    # The same IDs seeded again from another canvas reuse the record and its stamp.
    assert main_module._ensure_shared_graph_recoveries(
        [{"id": "n1", "definitionId": ENVIRONMENT, "params": {"existing_world_id": "world-s"}}],
        source="test", project_id="someone-else") == []
    assert recoveries.stamp_of(added[0]["runId"], "n1")["projectId"] == delta


def test_a_graph_update_seeds_with_the_open_canvas_owner(app, recoveries):
    client, *_ = app
    _alpha, delta = _delta_brief(client)
    put = client.put("/api/graph/node/n1", headers={**PERSON, "X-Nebula-Workspace-Revision": _rev(client)},
                     json={"definitionId": ENVIRONMENT})
    assert put.status_code in (200, 400, 422), put.text
    candidate = main_module.cli_graph.clone()
    candidate.nodes["n1"]["definitionId"] = ENVIRONMENT
    candidate.nodes["n1"]["params"] = {"resume_operation_id": "op-seed"}
    main_module._commit_graph_candidate_with_recoveries(candidate, [candidate.nodes["n1"]], source="update")
    [seeded] = [r for r in recoveries.list() if r["resumeOperationId"] == "op-seed"]
    assert recoveries.stamp_of(seeded["runId"], "n1") == {"projectId": delta, "nodeType": ENVIRONMENT}


# -- 4. Records saved before stamps ---------------------------------------------------------------

def test_the_startup_pass_stamps_only_what_one_history_places_once_and_logs_a_count(app, recoveries, capsys):
    client, store, *_ = app
    alpha, delta = _delta_brief(client)
    beta = _duplicate(store, alpha, "Beta")  # wl-run-alpha now in two histories
    with store.transaction() as catalog:
        catalog["projects"][delta]["snapshot"]["runHistory"].append(
            _record("wl-run-delta-2", "n1", {}, started=time.time() * 1000))
        store.commit(catalog)
    _set(recoveries, "wl-run-alpha")  # ambiguous: stays unstamped
    _set(recoveries, "wl-run-delta", node_id="n2")  # Delta's only
    _set(recoveries, "wl-run-nowhere", node_id="n3")  # no history
    _set(recoveries, "wl-run-delta-2", node_id="n4", project=alpha)  # already stamped: never restamped
    main_module._stamp_legacy_recoveries()
    out = capsys.readouterr().out
    assert "stamped 1 saved World Labs record with their project" in out
    assert "wl-run" not in out and "n2" not in out
    assert recoveries.stamp_of("wl-run-alpha", "n1") is None
    assert recoveries.stamp_of("wl-run-delta", "n2") == {"projectId": delta, "nodeType": None}
    assert recoveries.stamp_of("wl-run-nowhere", "n3") is None
    assert recoveries.stamp_of("wl-run-delta-2", "n4")["projectId"] == alpha
    journal = json.loads(Path(recoveries._path).read_text())
    main_module._stamp_legacy_recoveries()  # idempotent: nothing new, nothing written
    assert "stamped" not in capsys.readouterr().out
    assert json.loads(Path(recoveries._path).read_text()) == journal
    assert beta


def test_the_startup_pass_counts_recently_deleted(app, recoveries):
    client, store, *_ = app
    alpha, _delta = _delta_brief(client)
    with store.transaction() as catalog:
        entry = catalog["projects"].pop(alpha)
        entry["deletedAt"] = "2026-10-31T00:00:00+00:00"
        catalog.setdefault("trash", {})[alpha] = entry
        store.commit(catalog)
    _set(recoveries, "wl-run-alpha")
    main_module._stamp_legacy_recoveries()
    assert recoveries.stamp_of("wl-run-alpha", "n1")["projectId"] == alpha


def test_a_migrated_legacy_record_behaves_like_a_stamped_one(app, recoveries):
    client, *_ = app
    alpha, _delta = _delta_brief(client)
    _set(recoveries, "wl-run-alpha")
    _refused(client, SHARED, agent_too=False)
    main_module._stamp_legacy_recoveries()
    assert recoveries.stamp_of("wl-run-alpha", "n1")["projectId"] == alpha
    assert _delete(client).status_code == 200


def test_the_startup_pass_never_places_by_world_id(app, recoveries):
    """The coordinator's call 2: run history only."""
    client, store, *_ = app
    alpha, _delta = _delta_brief(client)
    with store.transaction() as catalog:
        for node in catalog["projects"][alpha]["snapshot"]["nodes"]:
            if node.get("id") == "n1":
                node["data"] = {**node["data"], "definitionId": ENVIRONMENT,
                                "params": {"resume_operation_id": "op-alpha"}}
        store.commit(catalog)
    _set(recoveries, "graph-seeded-1", op="op-alpha")
    main_module._stamp_legacy_recoveries()
    assert recoveries.stamp_of("graph-seeded-1", "n1") is None
    _refused(client, SHARED, agent_too=False)


# -- 5. The one type rule (GM r36 item 1) ---------------------------------------------------------

@pytest.mark.parametrize(("kwargs", "subject"), [
    ({"world": "world-1"}, "A World Labs Environment node"),
    ({"node_type": EXPORT}, "A World Labs Export node"),
    ({"node_type": ENVIRONMENT}, "A World Labs Environment node"),
    ({}, "A World Labs node"),
    ({"node_type": "text-input"}, "A World Labs node"),
], ids=["world-id", "stored-export", "stored-environment", "neither", "not-world-labs"])
def test_the_verdicts_subject_names_the_type_the_record_knows(app, recoveries, kwargs, subject):
    client, store, *_ = app
    alpha, _delta = _delta_brief(client)
    with store.transaction() as catalog:
        catalog["projects"].pop(alpha)  # the stamp's project is gone: no name can be known
        store.commit(catalog)
    _set(recoveries, "wl-run-ghost", project=alpha, **kwargs)
    facts = {"records": recoveries.list()}
    assert main_module._held_person_subject(main_module._catalog_for_the_hold(), "recovery", facts) == subject


def test_the_verdict_places_a_stamped_record_by_its_stamp(app, recoveries):
    client, *_ = app
    alpha, _delta = _delta_brief(client)
    _set(recoveries, "wl-run-nowhere", project=alpha)
    facts = {"records": recoveries.list()}
    assert main_module._held_person_subject(main_module._catalog_for_the_hold(), "recovery", facts) \
        == "“World” from “Alpha”"


# -- 6. The stamp stays internal; the person gets the places ---------------------------------------

def _agent_reads(client):
    return {path: client.get(path, headers=CODEX).json()
            for path in ("/api/graph", "/api/graph/export", "/api/canvas/snapshot")}


def test_agents_reads_are_byte_identical_with_and_without_stamps(app, recoveries):
    client, *_ = app
    alpha, _delta = _delta_brief(client)
    _set(recoveries, "wl-run-alpha")
    before = json.dumps(_agent_reads(client), sort_keys=True)
    listed = json.dumps(recoveries.list(), sort_keys=True)
    recoveries.stamp_unstamped(lambda _record: alpha)
    assert recoveries.stamp_of("wl-run-alpha", "n1")["projectId"] == alpha
    assert json.dumps(_agent_reads(client), sort_keys=True) == before
    assert json.dumps(recoveries.list(), sort_keys=True) == listed
    assert "providerRecoveryPlaces" not in before and alpha not in json.dumps(recoveries.list())


def test_the_persons_export_carries_the_places_and_an_agents_never_does(app, recoveries):
    client, store, *_ = app
    alpha, _delta = _delta_brief(client)
    gone = uuid.uuid4().hex
    _set(recoveries, "wl-run-alpha", project=alpha, node_type=EXPORT)
    _set(recoveries, "wl-run-gone", project=gone, node_id="n2")
    _set(recoveries, "wl-run-legacy", node_id="n3")
    person = client.get("/api/graph/export", headers=PERSON).json()
    assert sorted(person["providerRecoveryPlaces"], key=lambda place: place["runId"]) == [
        {"runId": "wl-run-alpha", "nodeId": "n1", "projectId": alpha, "nodeType": EXPORT},
        # A project deleted for good can't be known any more.
        {"runId": "wl-run-gone", "nodeId": "n2", "projectId": None, "nodeType": None},
    ]
    for headers in (CODEX, {}):
        assert "providerRecoveryPlaces" not in client.get("/api/graph/export", headers=headers).json()
    assert "providerRecoveryPlaces" not in client.get("/api/graph", headers=CODEX).json()


def test_graph_sync_sends_the_places_to_the_persons_sockets_only(app, recoveries, monkeypatch):
    client, *_ = app
    alpha, _delta = _delta_brief(client)
    _set(recoveries, "wl-run-alpha", project=alpha)
    sent = []

    async def capture(data, *, others=None):
        sent.append((data, others))
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    asyncio.run(main_module._broadcast_graph_sync())
    [(person, others)] = [(data, others) for data, others in sent if data.get("type") == "graphSync"]
    assert person["providerRecoveryPlaces"] == [
        {"runId": "wl-run-alpha", "nodeId": "n1", "projectId": alpha, "nodeType": None}]
    assert others is not None and "providerRecoveryPlaces" not in others
    assert {key: value for key, value in person.items() if key != "providerRecoveryPlaces"} == others


def test_graph_sync_with_no_stamped_record_goes_out_as_it_always_did(app, recoveries, monkeypatch):
    """Nothing to add: one frame, no person form, no places key."""
    sent = []

    async def capture(data, **kwargs):
        sent.append((data, kwargs))
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    asyncio.run(main_module._broadcast_graph_sync())
    [(frame, kwargs)] = [(data, kwargs) for data, kwargs in sent if data.get("type") == "graphSync"]
    assert kwargs == {} and "providerRecoveryPlaces" not in frame


def test_a_verified_hello_gets_the_places_and_an_unverified_socket_never_does(app, recoveries):
    client, *_ = app
    alpha, _delta = _delta_brief(client)
    _set(recoveries, "wl-run-alpha", project=alpha)

    def frames(ws, count):
        return [json.loads(ws.receive_text()) for _ in range(count)]

    with client.websocket_connect("/ws") as ws:
        first = frames(ws, 3)
        assert all("providerRecoveryPlaces" not in frame and frame.get("type") != "providerRecoveryPlaces"
                   for frame in first)
        ws.send_text(json.dumps({"type": "hello", "personToken": "wrong"}))
        assert json.loads(ws.receive_text())["type"] == "personRequired"
    with client.websocket_connect("/ws") as ws:
        frames(ws, 3)
        ws.send_text(json.dumps({"type": "hello", "personToken": PERSON["X-Nebula-Person"]}))
        # The hello's frames: the places come before the person's pins, and
        # the pins and the cursor replay stay the last syncs (fix 24, after the merge).
        got = []
        for _ in range(30):
            got.append(json.loads(ws.receive_text()))
            if got[-1].get("type") == "agentPresenceReplay":
                break
        types = [frame.get("type") for frame in got]
        assert types.index("providerRecoveryPlaces") < types.index("canvasPins") < types.index("agentPresenceReplay")
        assert got[types.index("providerRecoveryPlaces")] == {"type": "providerRecoveryPlaces", "places": [
            {"runId": "wl-run-alpha", "nodeId": "n1", "projectId": alpha, "nodeType": None}]}


# -- 7. The journal ----------------------------------------------------------------------------

def test_a_later_write_that_knows_one_field_keeps_the_other(tmp_path):
    # The run's project from the claim (no type known then), the type from a
    # later write that doesn't know the project: the stamp keeps both.
    store = ProviderRecoveryStore(tmp_path / "provider-recoveries.json")
    store.set(run_id="r1", node_id="n1", resume_operation_id="op-1", existing_world_id=None,
              project_id="p-alpha")
    store.set(run_id="r1", node_id="n1", resume_operation_id=None, existing_world_id="world-1",
              node_type=ENVIRONMENT)
    assert store.stamp_of("r1", "n1") == {"projectId": "p-alpha", "nodeType": ENVIRONMENT}
    store.set(run_id="r1", node_id="n1", resume_operation_id="op-2", existing_world_id=None)
    assert store.stamp_of("r1", "n1") == {"projectId": "p-alpha", "nodeType": ENVIRONMENT}
    assert ProviderRecoveryStore(tmp_path / "provider-recoveries.json").stamp_of("r1", "n1") == {
        "projectId": "p-alpha", "nodeType": ENVIRONMENT}


def test_the_journal_keeps_stamps_beside_records_and_only_when_there_are_any(tmp_path):
    path = tmp_path / "provider-recoveries.json"
    store = ProviderRecoveryStore(path)
    store.set(run_id="r1", node_id="n1", resume_operation_id="op-1", existing_world_id=None)
    assert "stamps" not in json.loads(path.read_text())
    store.set(run_id="r2", node_id="n2", resume_operation_id="op-2", existing_world_id=None,
              project_id="p-alpha", node_type=ENVIRONMENT)
    payload = json.loads(path.read_text())
    assert payload["records"] == store.list()
    assert payload["stamps"] == [{"runId": "r2", "nodeId": "n2", "projectId": "p-alpha", "nodeType": ENVIRONMENT}]
    again = ProviderRecoveryStore(path)
    assert again.stamp_of("r2", "n2") == {"projectId": "p-alpha", "nodeType": ENVIRONMENT}
    assert again.stamp_of("r1", "n1") is None
    # Renumbering moves the stamp with its record; delete and clear drop it.
    assert again.renumber_nodes({"n2": "n9"}) == 1
    assert again.stamp_of("r2", "n9")["projectId"] == "p-alpha" and again.stamp_of("r2", "n2") is None
    assert again.delete(run_id="r2", node_id="n9", resume_operation_id="op-2", existing_world_id=None)
    assert again.places() == [] and "stamps" not in json.loads(path.read_text())
    # A new record later at a deleted key never inherits the old stamp.
    again.set(run_id="r2", node_id="n9", resume_operation_id="op-9", existing_world_id=None)
    assert again.stamp_of("r2", "n9") is None
    again.delete(run_id="r2", node_id="n9", resume_operation_id="op-9", existing_world_id=None)
    again.set(run_id="r3", node_id="n3", resume_operation_id="op-3", existing_world_id=None, project_id="p")
    again.clear()
    assert again.places() == [] and again.stamp_of("r3", "n3") is None
    again.set(run_id="r3", node_id="n3", resume_operation_id="op-3b", existing_world_id=None)
    assert again.stamp_of("r3", "n3") is None
    again.clear()
    added = again.ensure_many(run_id="g1", checkpoints=[("n4", "op-4", None)], project_id="p",
                              node_types={"n4": EXPORT})
    assert again.stamp_of("g1", "n4") == {"projectId": "p", "nodeType": EXPORT}
    again.delete_many_exact(added)
    assert again.stamp_of("g1", "n4") is None and again.places() == []
    again.set(run_id="g1", node_id="n4", resume_operation_id="op-4b", existing_world_id=None)
    assert again.stamp_of("g1", "n4") is None
    # verify_writable reads back the records only and keeps the stamps.
    again.set(run_id="r5", node_id="n5", resume_operation_id="op-5", existing_world_id=None, project_id="p")
    again.verify_writable()
    assert ProviderRecoveryStore(path).stamp_of("r5", "n5")["projectId"] == "p"


@pytest.mark.parametrize("stamps", ["not-a-list", [1], [{"runId": [1], "nodeId": "n1"}]])
def test_an_unreadable_stamps_list_is_ignored_and_the_records_hold(tmp_path, caplog, stamps):
    path = tmp_path / "provider-recoveries.json"
    store = ProviderRecoveryStore(path)
    store.set(run_id="r1", node_id="n1", resume_operation_id="op-1", existing_world_id=None, project_id="p")
    payload = json.loads(path.read_text())
    payload["stamps"] = stamps
    path.write_text(json.dumps(payload))
    with caplog.at_level(logging.WARNING):
        again = ProviderRecoveryStore(path)
    assert again.is_healthy()
    assert again.list() == [{"runId": "r1", "nodeId": "n1", "resumeOperationId": "op-1", "existingWorldId": None}]
    assert again.stamp_of("r1", "n1") is None


def test_a_stamp_field_that_isnt_an_identifier_is_left_out(tmp_path):
    store = ProviderRecoveryStore(tmp_path / "j.json")
    store.set(run_id="r1", node_id="n1", resume_operation_id="op-1", existing_world_id=None,
              project_id=object(), node_type="x" * 500)
    assert store.stamp_of("r1", "n1") is None
    store.set(run_id="r1", node_id="n1", resume_operation_id="op-1b", existing_world_id=None,
              project_id="p\n", node_type=ENVIRONMENT)
    assert store.stamp_of("r1", "n1") == {"projectId": None, "nodeType": ENVIRONMENT}


# -- 8. RD NIT-2: a handoff's delete the guard refuses is said ---------------------------------------

def _handoff_with_dup(client, recoveries, *, stamp_other=False):
    alpha = _create(client, "Alpha")
    _add_text(client, "alpha-1")
    _named("World")
    _with_run(client, alpha, "wl-run-alpha")
    delta = _create(client, "Delta")
    _add_text(client, "delta-1")
    _with_run(client, delta, "wl-run-delta")
    tab = _stored(client, delta)
    tab["nodes"].append(_node(DUP, "text-input", {"value": "dup"}, 300))
    _autosave(client, delta, tab)
    assert client.put(f"/api/projects/{delta}", headers=TAB,
                      json={"workspaceRevision": _rev(client), "snapshot": tab}).status_code == 200
    old_rev = _rev(client)
    opened = _open(client, delta, headers=CODEX)
    assert opened.status_code == 200, opened.text
    new = opened.json()["renumbered"][DUP]
    # Delta's own run, stamped Delta; or Alpha's run, stamped Alpha, which releases.
    recoveries.set(run_id="wl-run-alpha" if stamp_other else "wl-run-delta", node_id=new,
                   resume_operation_id="op-1", existing_world_id=None, project_id=alpha if stamp_other else delta)
    held = _held(tab)
    held["nodes"] = [node for node in held["nodes"] if node["id"] != DUP]
    return delta, new, _handoff(client, delta, old_rev, held, deletedNodeIds=[DUP])


def test_a_handoff_delete_the_guard_refuses_stays_in_the_saved_copy_and_is_said(app, recoveries):
    client, store, *_ = app
    delta, new, answer = _handoff_with_dup(client, recoveries)
    assert answer.status_code == 200, answer.text
    assert new in main_module.cli_graph.nodes
    [held] = answer.json()["deletesHeld"]
    assert held["nodeId"] == new
    assert "has a saved World Labs recovery ID" in held["line"]
    assert "deletesKept" not in answer.json()
    with store.transaction() as catalog:
        assert new in {node["id"] for node in catalog["projects"][delta]["snapshot"]["nodes"]}


def test_a_handoff_delete_the_guard_allows_still_goes(app, recoveries):
    client, store, *_ = app
    delta, new, answer = _handoff_with_dup(client, recoveries, stamp_other=True)
    assert answer.status_code == 200, answer.text
    assert new not in main_module.cli_graph.nodes
    assert "deletesHeld" not in answer.json()
    with store.transaction() as catalog:
        assert new not in {node["id"] for node in catalog["projects"][delta]["snapshot"]["nodes"]}


@pytest.mark.parametrize("how", ["delete", "clear", "delete_many_exact"])
def test_a_removed_record_forgets_its_stamp_so_a_new_one_under_the_same_key_starts_unstamped(tmp_path, how):
    # fix 24: pins the behaviour. Mutants that skip the stamp pop in delete/clear/rollback
    # (J6/J7/J8) are equivalent: every call reloads from disk and _persist writes only
    # stamps whose record exists, so a stale in-memory stamp never survives to be read.
    store = ProviderRecoveryStore(tmp_path / "provider-recoveries.json")
    _set(store, "run-1", project="alpha", node_type=EXPORT)
    assert store.stamp_of("run-1", "n1")["projectId"] == "alpha"
    if how == "delete":
        assert store.delete(run_id="run-1", node_id="n1", resume_operation_id="op-1", existing_world_id=None)
    elif how == "clear":
        store.clear()
    else:
        store.delete_many_exact([{"runId": "run-1", "nodeId": "n1",
                                  "resumeOperationId": "op-1", "existingWorldId": None}])
    assert store.stamp_of("run-1", "n1") is None
    _set(store, "run-1")
    assert store.stamp_of("run-1", "n1") is None
