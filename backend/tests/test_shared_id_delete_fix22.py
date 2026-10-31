"""PR #199 fix round 22, the delete guard scoped to the record's project
(review 20 LOW-2; GM r34 addendum 2; Justin's answer, 2026-10-31).

Node ids repeat across projects. A World Labs recovery record holds a node
from deletion only when it is placed in the open project, can't be placed
at all, or the node's own settings hold the record's ID. Another project's
record holds nothing here: Delta's own n1 deletes while Alpha's n1 has a
record, for the person and for agents, and Alpha's record stays.
Ambiguities and active starts carry no ID and still hold by node id. When
Nebula still refuses, agents' text is as it was; the person's is the
record's own line, or GM's shared-id line (r34 addendum 2) when Nebula
knows the record is another project's but can't place it in one.
"""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main as main_module  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_project_catalog_restore_fix2 import app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix12 import CODEX  # noqa: E402
from tests.test_project_catalog_restore_fix21 import ENVIRONMENT, _alpha_then_delta, _named, recoveries  # noqa: E402,F401
from tests.test_project_catalog_restore_fix17 import _open, _rev  # noqa: E402

OLD_LINE = "“Delta brief” has a saved World Labs recovery ID. Check the run in Marble, then forget the ID in Run History."
UNNAMED = ("Nebula couldn’t delete “Delta brief” because it shares the ID n1 with a World Labs Environment node "
           "from another project, which has a saved World Labs recovery ID. Forget that ID in Run History, then try again.")
AGENT_DETAIL = ("Cannot delete n1: it has unresolved World Labs paid state. "
                "Check Marble, then resolve its exact recovery/ambiguity record first.")


def _delete(client, headers=PERSON, node_id="n1"):
    return client.request("DELETE", f"/api/graph/node/{node_id}",
                          headers={**headers, "X-Nebula-Workspace-Revision": _rev(client)})


def _delta_brief(client):
    alpha, delta = _alpha_then_delta(client)
    _named("Delta brief")
    return alpha, delta


def _alphas_record(recoveries, run_id="wl-run-alpha", op="op-1"):
    recoveries.set(run_id=run_id, node_id="n1", resume_operation_id=op, existing_world_id=None)


def _refused_as_before(client, *, agent_too=True):
    refused = _delete(client)
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"] == OLD_LINE
    assert "n1" in main_module.cli_graph.nodes
    if agent_too:
        agent = _delete(client, CODEX)
        assert agent.status_code == 409, agent.text
        assert agent.json()["detail"] == AGENT_DETAIL


@pytest.mark.parametrize("who", [PERSON, CODEX], ids=["person", "agent"])
def test_deltas_n1_deletes_while_alphas_n1_has_a_record_and_alphas_record_stays(app, recoveries, who):
    client, *_ = app
    _delta_brief(client)
    _alphas_record(recoveries)
    deleted = _delete(client, who)
    assert deleted.status_code == 200, deleted.text
    assert "n1" not in main_module.cli_graph.nodes
    assert [(r["runId"], r["nodeId"], r["resumeOperationId"]) for r in recoveries.list()] == [("wl-run-alpha", "n1", "op-1")]


def test_alphas_own_world_node_is_refused_in_alpha(app, recoveries):
    client, *_ = app
    alpha, _delta = _alpha_then_delta(client)
    assert _open(client, alpha).status_code == 200
    _alphas_record(recoveries)
    refused = _delete(client)
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"] == "“World” has a saved World Labs recovery ID. Check the run in Marble, then forget the ID in Run History."
    assert _delete(client, CODEX).json()["detail"] == AGENT_DETAIL
    assert "n1" in main_module.cli_graph.nodes


def test_the_open_projects_own_record_is_refused(app, recoveries):
    client, *_ = app
    _delta_brief(client)
    _alphas_record(recoveries, run_id="wl-run-delta")
    _refused_as_before(client)


def test_the_open_projects_record_keeps_its_own_line_when_a_duplicate_copied_its_run(app, recoveries):
    client, store, *_ = app
    _alpha, delta = _delta_brief(client)
    with store.transaction() as catalog:
        source = catalog["projects"][delta]
        twin_id = uuid.uuid4().hex
        catalog["projects"][twin_id] = {**source, "id": twin_id, "name": "Delta copy",
                                        "snapshot": {**source["snapshot"],
                                                     "runHistory": list(source["snapshot"].get("runHistory") or [])}}
        store.commit(catalog)
    _alphas_record(recoveries, run_id="wl-run-delta")
    _refused_as_before(client)


def test_a_record_nobody_can_place_is_refused(app, recoveries):
    client, *_ = app
    _delta_brief(client)
    _alphas_record(recoveries, run_id="wl-run-nowhere")
    _refused_as_before(client)


def test_a_run_in_two_other_projects_cant_be_placed_and_is_refused(app, recoveries):
    client, store, *_ = app
    alpha, _delta = _delta_brief(client)
    # A duplicate copies run history: the run is in Alpha's and Beta's, so whose can't be told.
    with store.transaction() as catalog:
        source = catalog["projects"][alpha]
        twin_id = uuid.uuid4().hex
        catalog["projects"][twin_id] = {**source, "id": twin_id, "name": "Beta",
                                        "snapshot": {**source["snapshot"],
                                                     "runHistory": list(source["snapshot"].get("runHistory") or [])}}
        store.commit(catalog)
    _alphas_record(recoveries)
    refused = _delete(client)
    assert refused.status_code == 409, refused.text
    # Not the open project's, though whose can't be told: GM's shared-id line, unnamed.
    assert refused.json()["detail"] == UNNAMED
    assert _delete(client, CODEX).json()["detail"] == AGENT_DETAIL
    assert "n1" in main_module.cli_graph.nodes


def test_the_shared_id_line_reads_only_the_records_that_hold(app, recoveries):
    """Beside a record whose run two other projects hold (it holds the node),
    a seeded record placed by its ID in Alpha holds nothing, so it doesn't
    change the line."""
    client, store, *_ = app
    alpha, _delta = _delta_brief(client)
    with store.transaction() as catalog:
        source = catalog["projects"][alpha]
        for node in source["snapshot"]["nodes"]:
            if node.get("id") == "n1":
                node["data"] = {**node["data"], "definitionId": ENVIRONMENT,
                                "params": {**(node["data"].get("params") or {}), "resume_operation_id": "op-alpha"}}
        twin_id = uuid.uuid4().hex
        catalog["projects"][twin_id] = {**source, "id": twin_id, "name": "Beta",
                                        "snapshot": {**source["snapshot"],
                                                     "nodes": [{**node, "data": {**node["data"], "params": {}}}
                                                               for node in source["snapshot"]["nodes"]],
                                                     "runHistory": list(source["snapshot"].get("runHistory") or [])}}
        store.commit(catalog)
    _alphas_record(recoveries)
    _alphas_record(recoveries, run_id="graph-seeded-1", op="op-alpha")
    refused = _delete(client)
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"] == UNNAMED


def test_a_run_registered_on_the_open_project_here_is_refused(app, recoveries, monkeypatch):
    client, *_ = app
    _alpha, delta = _delta_brief(client)

    class Run:
        canvas = (delta, "rev")
    real = main_module.execution_runs.get
    monkeypatch.setattr(main_module.execution_runs, "get", lambda run_id: Run() if run_id == "wl-run-alpha" else real(run_id))
    _alphas_record(recoveries)
    _refused_as_before(client)


def test_a_node_holding_another_projects_record_id_is_refused(app, recoveries):
    client, *_ = app
    _delta_brief(client)
    _alphas_record(recoveries)
    live = main_module.cli_graph.nodes["n1"]
    live["definitionId"] = ENVIRONMENT
    live["params"] = {**(live.get("params") or {}), "resume_operation_id": "op-1"}
    _refused_as_before(client)


def test_unknowns_fail_closed(app, recoveries, monkeypatch):
    client, *_ = app
    _delta_brief(client)
    _alphas_record(recoveries)
    record = recoveries.list()[0]
    node = main_module.cli_graph.nodes["n1"]
    assert main_module._recovery_record_holds_node(record, node) is False
    # No catalog to place it by, a canvas that isn't the open project's, or an error: it holds.
    # (monkeypatch.context, so the app's and the store's own patches stay.)
    with monkeypatch.context() as m:
        m.setattr(main_module, "_catalog_for_the_hold", lambda: {})
        assert main_module._recovery_record_holds_node(record, node) is True
    with monkeypatch.context() as m:
        m.setattr(main_module.cli_graph, "owner", "someone-else")
        assert main_module._recovery_record_holds_node(record, node) is True

    def boom(*_args, **_kwargs):
        raise RuntimeError("boom")
    with monkeypatch.context() as m:
        m.setattr(main_module, "_hold_run_project", boom)
        assert main_module._recovery_record_holds_node(record, node) is True
    # And with every patch gone, it is Alpha's again.
    assert main_module._recovery_record_holds_node(record, node) is False


def test_a_seeded_record_placed_by_its_id_in_alpha_lets_deltas_n1_go(app, recoveries):
    client, store, *_ = app
    alpha, _delta = _delta_brief(client)
    # Nebula seeds a record with a run id of its own, which no run history names: placed by its World Labs ID.
    with store.transaction() as catalog:
        for node in catalog["projects"][alpha]["snapshot"]["nodes"]:
            if node.get("id") == "n1":
                node["data"] = {**node["data"], "definitionId": ENVIRONMENT,
                                "params": {**(node["data"].get("params") or {}), "resume_operation_id": "op-alpha"}}
        store.commit(catalog)
    _alphas_record(recoveries, run_id="graph-seeded-1", op="op-alpha")
    deleted = _delete(client)
    assert deleted.status_code == 200, deleted.text
    assert "n1" not in main_module.cli_graph.nodes


def test_an_ambiguity_still_holds_by_node_id(app):
    client, *_ = app
    _delta_brief(client)
    main_module.provider_start_guard.mark_ambiguous(run_id="wl-run-alpha", node_id="n1", kind=ENVIRONMENT)
    refused = _delete(client)
    assert refused.status_code == 409, refused.text
    assert _delete(client, CODEX).json()["detail"] == AGENT_DETAIL
    assert "n1" in main_module.cli_graph.nodes


def test_an_active_start_still_holds_by_node_id(app, monkeypatch):
    client, *_ = app
    _delta_brief(client)
    monkeypatch.setattr(main_module.provider_start_guard, "has_active_node", lambda node_id: node_id == "n1")
    refused = _delete(client)
    assert refused.status_code == 409, refused.text
    assert _delete(client, CODEX).json()["detail"] == AGENT_DETAIL
    assert "n1" in main_module.cli_graph.nodes
