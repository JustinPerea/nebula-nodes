"""PR #199 fix round 21: review 19's backend items and GM r32.

- reopen-handoff MEDIUM-1, LOW-1, NIT-2 (GM r32 1): the open/replacement
  hold is the backend's own verdict, read with no side effect
  (``_graph_replacement_hold``: GET /api/projects/open-hold, the listing's
  ``openHold``, and ``hold`` on the open route's 409), with the held node and
  the project it belongs to; agents read it in list_projects and `nebula
  projects`. The states are one list both sides read
  (tests/data/replacement_hold_states.json).
- reopen-handoff LOW-3 (agents-docs LOW-1): a run result's landing stamp
  (``resultLandedAt``) is kept with it, so a handoff after a restart still
  knows which run is newer; equal times keep Nebula's.
- reopen-handoff LOW-4: a refused delete is never silent (``deletesKept``).
- reopen-handoff NIT-1: mutants B4, B12, B13b, B16; agents-docs NIT-1 (M3).
- agents-docs LOW-2: a recovered copy's source, for agents.
- agents-docs NIT-2 (GM r32 5): the person's newer result replacing a
  node's is journaled (``node.result``).
- agents-docs GM question (GM r32 6): the `nebula watch` line for a reopen in place.
"""
from __future__ import annotations

import asyncio
import io
import json
import sys
import time
from contextlib import redirect_stdout
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main as main_module  # noqa: E402
import project_client  # noqa: E402
from cli.client import NebulaClient  # noqa: E402
from cli.commands import projects as projects_cmd  # noqa: E402
from cli.formatter import format_event  # noqa: E402
from models.events import ExecutedEvent  # noqa: E402
from nebula_api import NebulaAPI  # noqa: E402
from services.node_errors import NodeErrors  # noqa: E402
from services.node_result_runs import NodeResultRuns  # noqa: E402
from services.provider_recovery import ProviderRecoveryStore  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _add_text, _create, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix12 import CODEX  # noqa: E402
from tests.test_project_catalog_restore_fix16 import _node  # noqa: E402
from tests.test_project_catalog_restore_fix17 import DUP, _on_disk, _open, _rev, _stored  # noqa: E402
from tests.test_project_catalog_restore_fix18 import _handoff, _live  # noqa: E402
from tests.test_project_catalog_restore_fix20_review18 import (  # noqa: E402
    TAB_A, TAB_B, WINDOW_A, _copy, _delta, _disk_ids, _disk_node, _events, _record, _save, _text, _with_result)

ROOT = Path(__file__).resolve().parent.parent.parent
STATES = json.loads((Path(__file__).resolve().parent / "data" / "replacement_hold_states.json").read_text())
ENVIRONMENT = "worldlabs-environment"
DUP2 = "3b73f9bb-0c3d-4e5f-8a9b-0c1d2e3f4a5d"
TAB_A_RELOADED = TAB_A  # the same tab id across a reload (the tab keeps it in sessionStorage)


@pytest.fixture(autouse=True)
def _fresh_books(monkeypatch):
    monkeypatch.setattr(main_module, "node_result_runs", NodeResultRuns(), raising=False)
    monkeypatch.setattr(main_module, "node_errors", NodeErrors(None))


@pytest.fixture
def recoveries(tmp_path, monkeypatch):
    store = ProviderRecoveryStore(tmp_path / "provider-recoveries.json")
    monkeypatch.setattr(main_module, "provider_recovery_store", store)
    return store


def _hold(client, headers=PERSON):
    answer = client.get("/api/projects/open-hold", headers=headers)
    assert answer.status_code == 200, answer.text
    return answer.json()["hold"]


def _listing_hold(client, headers=PERSON):
    return client.get("/api/projects", headers=headers).json()["openHold"]


def _named(name: str) -> None:
    main_module.cli_graph.set_label("n1", name)


def _with_run(client, project_id: str, run_id: str) -> None:
    """The open project's stored run history gets a record of ``run_id``
    (the tab's autosave of its Run History)."""
    snapshot = _stored(client, project_id)
    snapshot["runHistory"] = [_record(run_id, "n1", {}, started=time.time() * 1000)]
    _save(client, project_id, snapshot)


def _alpha_then_delta(client) -> tuple[str, str]:
    """Alpha ("World", run wl-run-alpha in its history), then Delta (open,
    its n1 "Delta World", run wl-run-delta)."""
    alpha = _create(client, "Alpha")
    _add_text(client, "alpha-1")
    _named("World")
    _with_run(client, alpha, "wl-run-alpha")
    delta = _create(client, "Delta")
    _add_text(client, "delta-1")
    _named("Delta World")
    _with_run(client, delta, "wl-run-delta")
    return alpha, delta


def _verdict(state, *, node=None, name=None, project=None, project_name=None, count=1, fields=(), detail=None):
    return {"state": state, "nodeId": node, "nodeName": name, "projectId": project, "projectName": project_name,
            "count": count, "fields": list(fields), "detail": detail}


UNRESOLVED = ("Cannot switch projects while unresolved World Labs paid state exists. "
              "Check Marble and resolve the exact recovery/ambiguity record first.")


def _refused_hold(client, project_id: str, headers=CODEX) -> dict:
    refused = _open(client, project_id, headers=headers)
    assert refused.status_code == 409, refused.text
    return refused.json()


# -- A. the hold, from the backend's own guards -------------------------------------------------

def test_a_nothing_holds(app):
    client, *_ = app
    delta = _create(client, "Delta")
    assert _hold(client) is None and _listing_hold(client) is None
    assert _open(client, delta, headers=CODEX).status_code == 200


def test_a_recovery_of_the_open_projects_node(app, recoveries):
    client, *_ = app
    _alpha, delta = _alpha_then_delta(client)
    recoveries.set(run_id="wl-run-delta", node_id="n1", resume_operation_id="op-1", existing_world_id=None)
    expected = _verdict("recovery", node="n1", name="Delta World", project=delta, project_name="Delta",
                        detail=UNRESOLVED)
    assert _hold(client) == expected and _hold(client, CODEX) == expected
    assert _listing_hold(client) == expected
    body = _refused_hold(client, delta)
    assert body["hold"] == expected and body["detail"] == UNRESOLVED  # agents' detail unchanged
    person = _refused_hold(client, delta, PERSON)
    assert person["hold"] == expected
    assert person["detail"] == ("“Delta World” has a saved World Labs recovery ID. "
                                "Check the run in Marble, then forget the ID in Run History.")


def test_a_recovery_of_another_projects_node_names_that_project(app, recoveries):
    """GM r32 1 (item 8): node ids repeat across projects; the record's run
    says whose it is, and the name comes from that project's copy."""
    client, *_ = app
    alpha, delta = _alpha_then_delta(client)
    recoveries.set(run_id="wl-run-alpha", node_id="n1", resume_operation_id="op-a", existing_world_id=None)
    expected = _verdict("recovery", node="n1", name="World", project=alpha, project_name="Alpha", detail=UNRESOLVED)
    assert _hold(client) == expected
    assert _refused_hold(client, delta)["hold"] == expected


def test_a_two_recovery_records_are_counted(app, recoveries):
    client, *_ = app
    alpha, _delta = _alpha_then_delta(client)
    recoveries.set(run_id="wl-run-alpha", node_id="n1", resume_operation_id="op-a", existing_world_id=None)
    recoveries.set(run_id="wl-run-delta", node_id="n1", resume_operation_id="op-d", existing_world_id=None)
    hold = _hold(client)
    assert hold["state"] == "recovery" and hold["count"] == 2


def test_a_a_run_no_project_holds_is_never_guessed_from_the_node_id(app, recoveries):
    """n1 is on the live canvas, but the record's run is in no project's
    history: the project and name aren't known, so they are null."""
    client, *_ = app
    _alpha_then_delta(client)
    recoveries.set(run_id="wl-run-nowhere", node_id="n1", resume_operation_id="op-x", existing_world_id=None)
    assert _hold(client) == _verdict("recovery", node="n1", detail=UNRESOLVED)


def test_a_a_run_two_projects_hold_is_not_guessed_either(app, recoveries):
    client, *_ = app
    alpha = _create(client, "Alpha")
    _add_text(client, "alpha-1")
    _with_run(client, alpha, "wl-run-shared")
    beta = _create(client, "Beta")
    _add_text(client, "beta-1")
    _with_run(client, beta, "wl-run-shared")  # a duplicate copies run history
    _create(client, "Delta")
    recoveries.set(run_id="wl-run-shared", node_id="n1", resume_operation_id="op-s", existing_world_id=None)
    hold = _hold(client)
    assert (hold["projectId"], hold["projectName"], hold["nodeName"]) == (None, None, None)


def test_a_the_open_project_is_read_first_when_another_has_the_run_too(app, recoveries):
    """A duplicate copies run history: when the open project has the run,
    it is the one named."""
    client, *_ = app
    alpha = _create(client, "Alpha")
    _add_text(client, "alpha-1")
    _with_run(client, alpha, "wl-run-both")
    delta = _create(client, "Delta")
    _add_text(client, "delta-1")
    _named("Delta World")
    _with_run(client, delta, "wl-run-both")
    recoveries.set(run_id="wl-run-both", node_id="n1", resume_operation_id="op-b", existing_world_id=None)
    hold = _hold(client)
    assert (hold["projectId"], hold["projectName"], hold["nodeName"]) == (delta, "Delta", "Delta World")


def test_a_a_run_this_process_registered_names_its_project(app, recoveries):
    """No stored run history has the run: the project Nebula registered the
    run on (execution_runs) says whose it is."""
    client, *_ = app
    alpha = _create(client, "Alpha")
    _add_text(client, "alpha-1")
    _named("World")

    class _Task:
        def add_done_callback(self, _callback):
            pass

        def cancel(self):
            pass

    _create(client, "Delta")
    main_module.execution_runs.register("wl-run-live", _Task(), canvas=(alpha, 0))
    recoveries.set(run_id="wl-run-live", node_id="n1", resume_operation_id="op-l", existing_world_id=None)
    hold = _hold(client)
    assert (hold["projectId"], hold["projectName"], hold["nodeName"]) == (alpha, "Alpha", "World")


def test_a_ambiguities_name_their_node_and_project_and_count(app):
    client, *_ = app
    alpha, delta = _alpha_then_delta(client)
    main_module.provider_start_guard.mark_ambiguous(run_id="wl-run-alpha", node_id="n1", kind=ENVIRONMENT)
    expected = _verdict("ambiguity", node="n1", name="World", project=alpha, project_name="Alpha", detail=UNRESOLVED)
    assert _hold(client) == expected
    assert _refused_hold(client, delta)["hold"] == expected
    main_module.provider_start_guard.mark_ambiguous(run_id="wl-run-delta", node_id="n1",
                                                    kind="worldlabs-world-export")
    assert _hold(client)["count"] == 2


def test_a_params_names_the_open_projects_node_and_its_fields(app, recoveries):
    client, *_ = app
    delta = _create(client, "Delta")
    world = main_module.cli_graph.add_node(ENVIRONMENT, {"resume_operation_id": "op-p"})
    main_module.cli_graph.set_label(world, "World")
    expected = _verdict("params", node=world, name="World", project=delta, project_name="Delta",
                        fields=["Resume Operation ID"], detail=UNRESOLVED)
    assert _hold(client) == expected
    # The open's fence seeds the journal from the canvas first (as before
    # this round), so its refusal may already be the recovery record the
    # seed wrote: the hold it carries is the guard's own verdict then.
    body = _refused_hold(client, delta)
    assert body["hold"] == _hold(client) and body["hold"]["state"] in {"params", "recovery"}
    # The seeded record has a run id of its own: its project is the one
    # whose node holds the same World Labs ID (here the open one).
    assert (body["hold"]["nodeId"], body["hold"]["nodeName"], body["hold"]["projectId"]) == (world, "World", delta)


def test_a_a_seeded_record_is_placed_by_its_world_labs_id(app, recoveries):
    """No run history names the record's run: the project whose node with
    that id holds the same World Labs ID is named (Alpha's stored copy),
    never a project whose node only shares the id (Delta's n1)."""
    client, store, *_ = app
    alpha = _create(client, "Alpha")
    _create(client, "Delta")
    _add_text(client, "delta-1")
    with store.transaction() as catalog:
        world = _node("n1", ENVIRONMENT, {"resume_operation_id": "op-alpha"})
        world["data"]["label"] = "World"
        catalog["projects"][alpha]["snapshot"]["nodes"].append(world)
        store.commit(catalog)
    recoveries.set(run_id="graph-mutation-preflight-x", node_id="n1", resume_operation_id="op-alpha",
                   existing_world_id=None)
    hold = _hold(client)
    assert (hold["state"], hold["nodeId"], hold["nodeName"], hold["projectId"], hold["projectName"]) \
        == ("recovery", "n1", "World", alpha, "Alpha")
    recoveries.delete_many_exact(recoveries.list())
    recoveries.set(run_id="graph-mutation-preflight-y", node_id="n1", resume_operation_id="op-elsewhere",
                   existing_world_id=None)
    hold = _hold(client)
    assert (hold["projectId"], hold["nodeName"]) == (None, None)


def test_a_a_seeded_record_of_the_live_canvas_names_the_open_project(app, recoveries):
    """The live canvas holds the ID before any save has laid it into the
    stored copy: the open project is named from the live node."""
    client, *_ = app
    delta = _create(client, "Delta")
    world = main_module.cli_graph.add_node(ENVIRONMENT, {"resume_operation_id": "op-live"})
    main_module.cli_graph.set_label(world, "World")
    recoveries.set(run_id="graph-mutation-preflight-z", node_id=world, resume_operation_id="op-live",
                   existing_world_id=None)
    hold = _hold(client)  # a read lays nothing into the stored copy
    assert (hold["state"], hold["nodeName"], hold["projectId"]) == ("recovery", "World", delta)


def test_a_active(app, monkeypatch):
    client, *_ = app
    delta = _create(client, "Delta")
    monkeypatch.setattr(main_module.provider_start_guard, "has_active", lambda: True)
    expected = _verdict("active", detail=main_module._graph_settling_specific("switch projects"))
    assert _hold(client) == expected
    body = _refused_hold(client, delta)
    assert body["hold"] == expected and body["code"] == "paid_start"


def test_a_bootstrap_is_read_without_the_retry_and_refused_after_it(app, monkeypatch):
    client, *_ = app
    delta = _create(client, "Delta")
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", "journal unwritable")
    retries: list[str] = []

    def retry(action):
        retries.append(action)
        return False

    monkeypatch.setattr(main_module, "_retry_graph_recovery_bootstrap", retry)
    expected = _verdict("bootstrap", detail=main_module._graph_bootstrap_specific("switch projects"))
    assert _hold(client) == expected and _listing_hold(client) == expected
    assert retries == []  # a read never retries
    body = _refused_hold(client, delta)
    assert body["hold"] == expected and retries  # the refusal did


def test_a_bootstrap_retry_that_holds_lets_the_open_go(app, monkeypatch):
    client, *_ = app
    delta = _create(client, "Delta")
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", "journal unwritable")

    def retry(_action):
        main_module._graph_recovery_bootstrap_error = None
        return True

    monkeypatch.setattr(main_module, "_retry_graph_recovery_bootstrap", retry)
    assert _open(client, delta, headers=CODEX).status_code == 200


def test_a_run_and_its_person_line(app, monkeypatch):
    client, *_ = app
    delta = _create(client, "Delta")
    monkeypatch.setattr(main_module.execution_runs, "has_active", lambda: True)
    specific = "Cannot switch projects while a run is active. Wait for the run to finish or stop it first."
    expected = _verdict("run", detail=specific)
    assert _hold(client) == expected
    agent = _refused_hold(client, delta)
    assert agent["hold"] == expected and agent["detail"] == specific
    person = _refused_hold(client, delta, PERSON)
    assert person["hold"] == expected and person["detail"] == main_module.CLEAR_DURING_RUN_PERSON


def test_a_world_labs_comes_before_a_run(app, recoveries, monkeypatch):
    client, *_ = app
    _alpha_then_delta(client)
    monkeypatch.setattr(main_module.execution_runs, "has_active", lambda: True)
    recoveries.set(run_id="wl-run-delta", node_id="n1", resume_operation_id="op-1", existing_world_id=None)
    assert _hold(client)["state"] == "recovery"


def test_a_a_read_takes_no_fence_and_writes_nothing(app, recoveries, monkeypatch):
    client, *_ = app
    _alpha_then_delta(client)
    recoveries.set(run_id="wl-run-delta", node_id="n1", resume_operation_id="op-1", existing_world_id=None)

    def no_fence():
        raise AssertionError("a read of the hold took the paid lifecycle fence")

    monkeypatch.setattr(main_module.provider_start_guard, "exclusive_lifecycle", no_fence)
    before = main_module.canvas_events.latest
    assert _hold(client)["state"] == "recovery"
    assert main_module.canvas_events.latest == before


def test_a_forget_id_clears_the_hold(app, recoveries):
    client, *_ = app
    _alpha, delta = _alpha_then_delta(client)
    recoveries.set(run_id="wl-run-delta", node_id="n1", resume_operation_id="op-1", existing_world_id=None)
    assert _hold(client)["state"] == "recovery"
    recoveries.delete_many_exact(recoveries.list())
    assert _hold(client) is None
    assert _open(client, delta, headers=CODEX).status_code == 200


def test_a_the_states_file_is_every_state_the_verdict_answers(app, recoveries, monkeypatch):
    """Both sides read tests/data/replacement_hold_states.json (the tab's
    parity test too): each state is in it, and nothing else."""
    assert STATES == list(main_module.REPLACEMENT_HOLD_STATES)
    client, *_ = app
    _alpha_then_delta(client)
    seen: list[str] = []
    monkeypatch.setattr(main_module.execution_runs, "has_active", lambda: True)
    seen.append(_hold(client)["state"])
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", "x")
    seen.append(_hold(client)["state"])
    world = main_module.cli_graph.add_node(ENVIRONMENT, {"resume_operation_id": "op-p"})
    seen.append(_hold(client)["state"])
    recoveries.set(run_id="wl-run-delta", node_id=world, resume_operation_id="op-p", existing_world_id=None)
    seen.append(_hold(client)["state"])
    main_module.provider_start_guard.mark_ambiguous(run_id="wl-run-delta", node_id=world, kind=ENVIRONMENT)
    seen.append(_hold(client)["state"])
    monkeypatch.setattr(main_module.provider_start_guard, "has_active", lambda: True)
    seen.append(_hold(client)["state"])
    assert sorted(seen) == sorted(STATES) and len(set(seen)) == len(seen)


def test_a_agents_read_the_hold_in_list_projects_and_nebula_projects(app, recoveries):
    client, *_ = app
    _alpha_then_delta(client)
    recoveries.set(run_id="wl-run-delta", node_id="n1", resume_operation_id="op-1", existing_world_id=None)
    listed = project_client.list_projects(NebulaAPI("http://testserver", client=client), headers=CODEX)
    note = f"Opening or switching projects is held: {UNRESOLVED}"
    assert listed["openHold"]["state"] == "recovery" and listed["openHold"]["note"] == note
    cli = NebulaClient("http://testserver")
    cli._client = client
    out = io.StringIO()
    with redirect_stdout(out):
        projects_cmd.run_list(cli)
    assert f"Note: {note}" in out.getvalue()
    recoveries.delete_many_exact(recoveries.list())
    assert "openHold" not in project_client.list_projects(NebulaAPI("http://testserver", client=client),
                                                          headers=CODEX)


# -- B. the landing stamp: the newer run, across a restart ----------------------------------------

def _quiet(monkeypatch):
    async def quiet(*_args, **_kwargs):
        return None

    monkeypatch.setattr(main_module.manager, "broadcast", quiet)


def _lands(node_id: str, value: str, run_id: str) -> None:
    asyncio.run(main_module._emit_and_sync(ExecutedEvent(node_id=node_id, outputs=_text(value), run_id=run_id)))


def _restart(state_path) -> None:
    """Nebula restarts: the in-memory landings go, the live graph is read back from state.json."""
    main_module.node_result_runs = NodeResultRuns()
    main_module.cli_graph.load(state_path)


def test_b_a_landing_is_stamped_on_the_live_node_and_its_stored_copy(app, monkeypatch):
    client, store, _graph, state_path = app
    _quiet(monkeypatch)
    delta = _create(client, "Delta")
    _add_text(client, "delta-1")
    before = time.time() * 1000
    _lands("n1", "ran", "run-1")
    stamp = main_module.cli_graph.nodes["n1"][main_module.RESULT_LANDED_KEY]
    assert before <= stamp <= time.time() * 1000
    assert json.loads(state_path.read_text())["nodes"][0][main_module.RESULT_LANDED_KEY] == stamp
    assert _live(client)["n1"]["data"][main_module.RESULT_LANDED_KEY] == stamp
    stored = _stored(client, delta)
    assert next(node for node in stored["nodes"] if node["id"] == "n1")["data"]["resultLandedAt"] == stamp
    # The tab's autosave never sets or drops it: it is Nebula's.
    dropped = _copy(stored)
    dropped["nodes"][0]["data"].pop("resultLandedAt")
    _save(client, delta, dropped)
    assert _disk_node(store, delta, "n1")["data"]["resultLandedAt"] == stamp
    forged = _copy(stored)
    forged["nodes"][0]["data"]["resultLandedAt"] = stamp + 10_000
    _save(client, delta, forged)
    assert _disk_node(store, delta, "n1")["data"]["resultLandedAt"] == stamp


def test_b_a_restart_between_the_agents_run_and_the_handoff_keeps_the_agents_later_result(app, monkeypatch):
    """The reviewer's probe (agents-docs LOW-1), with a real restart: the
    agent's run of n2 landed after the open; Nebula restarts; the tab's
    handoff holds an older run's result. The stamp kept with n2's result
    says the agent's is newer."""
    client, store, _graph, state_path = app
    _quiet(monkeypatch)
    delta, window_a, _b = _delta(client)
    now = time.time() * 1000
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    _lands(new, "AGENT-LATER", "agent-run")
    _restart(state_path)
    held = _with_result(window_a, DUP, outputs=_text("TAB-OLD"), state="complete")
    held["runHistory"] = [_record("tab-run", DUP, _text("TAB-OLD"), started=now - 120_000)]
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert _live(client)[new]["data"]["outputs"] == _text("AGENT-LATER")
    assert next(node for node in _stored(client, delta)["nodes"] if node["id"] == new)["data"]["outputs"] \
        == _text("AGENT-LATER")


def test_b_after_a_restart_the_tabs_newer_run_still_wins(app, monkeypatch):
    client, store, _graph, state_path = app
    _quiet(monkeypatch)
    delta, window_a, _b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    _lands(new, "AGENT", "agent-run")
    _restart(state_path)
    later = time.time() * 1000 + 60_000
    held = _with_result(window_a, DUP, outputs=_text("TAB-NEW"), state="complete")
    held["runHistory"] = [_record("tab-run", DUP, _text("TAB-NEW"), started=later)]
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert _live(client)[new]["data"]["outputs"] == _text("TAB-NEW")
    stored = _disk_node(store, delta, new)["data"]
    assert stored["outputs"] == _text("TAB-NEW")
    # Its stamp is the tab record's finish time now (startedAt + durationSec).
    assert stored["resultLandedAt"] == later + 1_000
    assert main_module.cli_graph.nodes[new]["resultLandedAt"] == later + 1_000


def _switched_away(client) -> tuple[str, str, dict]:
    """Delta, then an agent opens Other: the tab's handoff into Delta judges n1's result."""
    other = _create(client, "Other")
    delta, window_a, _b = _delta(client)
    old_rev = _rev(client)
    assert _open(client, other, headers=CODEX).status_code == 200
    return delta, old_rev, window_a


def _stamp_stored(store, client, project_id: str, node_id: str, stamp, outputs: dict) -> None:
    """Nebula's stored result on a node of a project that isn't open, with its stamp (or none)."""
    with store.transaction() as catalog:
        node = next(n for n in catalog["projects"][project_id]["snapshot"]["nodes"] if n["id"] == node_id)
        node["data"]["outputs"] = outputs
        if stamp is None:
            node["data"].pop("resultLandedAt", None)
        else:
            node["data"]["resultLandedAt"] = stamp
        store.commit(catalog)


@pytest.mark.parametrize("tab_offset,stored_stamp,expected", [
    (0, "same", "NEBULA"),       # equal times: Nebula's stands (B13b)
    (1, "same", "TAB"),          # the tab's a millisecond later
    (-1, "same", "NEBULA"),
    (0, None, "TAB"),            # Nebula's result saved before the stamp existed: the timed side wins
])
def test_b_the_clock_decides_with_the_stored_stamp(app, tab_offset, stored_stamp, expected):
    client, store, *_ = app
    delta, old_rev, window_a = _switched_away(client)
    finished = time.time() * 1000 - 30_000
    _stamp_stored(store, client, delta, "n1", finished if stored_stamp == "same" else None, _text("NEBULA"))
    held = _with_result(window_a, "n1", outputs=_text("TAB"), state="complete")
    held["runHistory"] = [_record("tab-run", "n1", _text("TAB"), started=finished - 1_000 + tab_offset, took=1.0)]
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert _disk_node(store, delta, "n1")["data"]["outputs"] == _text(expected)


@pytest.mark.parametrize("stored_outputs,expected", [
    (_text("NEBULA"), "NEBULA"),   # neither side has a time: Nebula's stands
    ({}, "TAB"),                   # ... unless it holds no result
])
def test_b_neither_side_timed(app, stored_outputs, expected):
    client, store, *_ = app
    delta, old_rev, window_a = _switched_away(client)
    _stamp_stored(store, client, delta, "n1", None, stored_outputs)
    held = _with_result(window_a, "n1", outputs=_text("TAB"), state="complete")
    record = _record("tab-run", "n1", _text("TAB"), started=1)
    record.pop("startedAt")
    held["runHistory"] = [record]
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    got = _disk_node(store, delta, "n1")["data"]["outputs"]
    assert got == (stored_outputs if expected == "NEBULA" else _text("TAB"))


def test_b_a_timed_nebula_result_beats_an_untimed_tab_record(app):
    client, store, *_ = app
    delta, old_rev, window_a = _switched_away(client)
    _stamp_stored(store, client, delta, "n1", time.time() * 1000 - 3_600_000, _text("NEBULA"))
    held = _with_result(window_a, "n1", outputs=_text("TAB"), state="complete")
    record = _record("tab-run", "n1", _text("TAB"), started=1)
    record.pop("startedAt")
    held["runHistory"] = [record]
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert _disk_node(store, delta, "n1")["data"]["outputs"] == _text("NEBULA")


def test_b_equal_times_with_an_in_process_landing_keep_nebulas(app):
    """The renumbered branch, the landing seen in this process (B13b's own line)."""
    client, store, *_ = app
    delta, window_a, _b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    at = time.time() * 1000 - 10_000
    main_module.cli_graph.nodes[new]["outputs"] = _text("AGENT")
    main_module.node_result_runs.landed(delta, new, "agent-run", at=at)
    held = _with_result(window_a, DUP, outputs=_text("TAB"), state="complete")
    held["runHistory"] = [_record("tab-run", DUP, _text("TAB"), started=at - 1_000, took=1.0)]
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert _live(client)[new]["data"]["outputs"] == _text("AGENT")


def test_b12_the_tabs_unchanged_result_never_replaces_what_nebulas_side_changed(app):
    """No landing was recorded (no run), but Nebula's copy of n2's result
    moved after the open: the tab's result, as the open loaded it, stays out."""
    client, store, *_ = app
    delta, window_a, _b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    main_module.cli_graph.nodes[new]["outputs"] = _text("NEBULA-SIDE")
    _stored(client, delta)  # a read lays the live node over the stored copy
    assert _handoff(client, delta, old_rev, _copy(window_a), headers=TAB_A).status_code == 200
    assert _live(client)[new]["data"]["outputs"] == _text("NEBULA-SIDE")
    assert _disk_node(store, delta, new)["data"]["outputs"] == _text("NEBULA-SIDE")


# -- C. a refused delete is never silent; item 18 (M3) and B4 ----------------------------------------

def test_c_the_reloaded_window_with_its_tab_id_deletes(app):
    client, store, *_ = app
    delta, window_a, _b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    held = _copy(window_a)
    held["nodes"] = [node for node in held["nodes"] if node["id"] != DUP]
    answer = _handoff(client, delta, old_rev, held, headers=TAB_A_RELOADED, deletedNodeIds=[DUP])
    assert answer.status_code == 200 and "deletesKept" not in answer.json()
    assert new not in _live(client) and _disk_ids(store, delta) == ["n1"]


@pytest.mark.parametrize("by", ["old", "new"])
def test_c_a_window_that_never_saved_it_gets_deletes_kept(app, by):
    client, store, *_ = app
    delta, _window_a, window_b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    since = main_module.canvas_events.latest
    answer = _handoff(client, delta, old_rev, _copy(window_b), headers=TAB_B,
                      deletedNodeIds=[DUP if by == "old" else new])
    assert answer.status_code == 200, answer.text
    assert answer.json()["deletesKept"] == [new]
    assert new in _live(client) and _disk_ids(store, delta) == sorted(["n1", new])
    assert not _events("node.removed", since)


def test_c_m3_b4_a_left_out_node_stays_once_any_delete_is_listed(app):
    """Window A saved two duplicates and lists only the first as deleted;
    the second is left out of its handoff (a stale or partial snapshot)
    without being listed: it stays, live and on disk."""
    client, store, *_ = app
    delta, window_a, _b = _delta(client)
    window_a["nodes"].append(_node(DUP2, "text-input", {"value": "dup2"}, 600))
    _save(client, delta, window_a)
    old_rev = _rev(client)
    renumbered = _open(client, delta, headers=CODEX).json()["renumbered"]
    first, second = renumbered[DUP], renumbered[DUP2]
    held = _copy(window_a)
    held["nodes"] = [node for node in held["nodes"] if node["id"] not in (DUP, DUP2)]
    answer = _handoff(client, delta, old_rev, held, headers=TAB_A, deletedNodeIds=[DUP])
    assert answer.status_code == 200 and "deletesKept" not in answer.json()
    assert first not in _live(client) and second in _live(client)
    assert _disk_ids(store, delta) == sorted(["n1", second])


# -- B16: a moved checkpoint never overwrites one at its new key --------------------------------------

def test_b16_a_renumber_never_overwrites_a_checkpoint_at_the_new_key(tmp_path):
    recoveries = ProviderRecoveryStore(tmp_path / "provider-recoveries.json")
    recoveries.set(run_id="wl-run", node_id="n9", resume_operation_id="op-n9", existing_world_id=None)
    recoveries.set(run_id="wl-run", node_id="tab-local", resume_operation_id="op-tab", existing_world_id=None)
    recoveries.set(run_id="wl-run", node_id="n5", resume_operation_id="op-n5", existing_world_id=None)
    assert recoveries.renumber_nodes({"tab-local": "n9", "n5": "n9"}) == 0
    kept = {(record["nodeId"], record["resumeOperationId"]) for record in recoveries.list()}
    assert kept == {("n9", "op-n9"), ("tab-local", "op-tab"), ("n5", "op-n5")}


# -- item 17: a recovered copy's source, for agents --------------------------------------------------

def _recover(client, source_id: str, name: str | None = None, shown: str | None = None) -> dict:
    snapshot = client.get(f"/api/projects/{source_id}", headers=PERSON).json()["snapshot"] \
        if client.get(f"/api/projects/{source_id}", headers=PERSON).status_code == 200 \
        else {"nodes": [], "edges": [], "runHistory": [], "viewport": None}
    body = {"recoveryId": __import__("uuid").uuid4().hex, "sourceProjectId": source_id, "snapshot": snapshot,
            **({"name": name} if name else {}), **({"sourceName": shown} if shown else {})}
    answer = client.post("/api/projects/recover", json=body, headers=PERSON)
    assert answer.status_code == 200, answer.text
    return answer.json()


def _created(since: int, project_id: str) -> dict:
    return next(event for event in _events("project.created", since) if event["data"]["projectId"] == project_id)


def test_17_two_copies_with_one_name_each_name_their_own_source(app):
    client, *_ = app
    shot_copy = _create(client, "Shot 7 copy")
    shot = _create(client, "Shot 7")
    since = main_module.canvas_events.latest
    one = _recover(client, shot_copy, name="Recovered Shot 7 copy")["project"]["id"]
    two = _recover(client, shot, name="Recovered Shot 7 copy")["project"]["id"]
    assert _created(since, one)["data"]["sourceName"] == "Shot 7 copy"
    assert _created(since, one)["data"]["sourceProjectId"] == shot_copy
    assert _created(since, two)["data"]["sourceName"] == "Shot 7"
    assert _created(since, two)["data"]["sourceProjectId"] == shot
    api = NebulaAPI("http://testserver", client=client)
    rows = {row["id"]: row for row in project_client.list_projects(api, headers=CODEX)["projects"]}
    assert (rows[one]["sourceName"], rows[one]["sourceProjectId"]) == ("Shot 7 copy", shot_copy)
    assert (rows[two]["sourceName"], rows[two]["sourceProjectId"]) == ("Shot 7", shot)
    assert "sourceName" not in rows[shot]  # not a recovered copy
    read = project_client.get_project(api, two, headers=CODEX)
    assert (read["sourceName"], read["sourceProjectId"]) == ("Shot 7", shot)
    cli = NebulaClient("http://testserver")
    cli._client = client
    out = io.StringIO()
    with redirect_stdout(out):
        projects_cmd.run_list(cli)
    lines = out.getvalue().splitlines()
    assert any(one in line and f'recovered copy of "Shot 7 copy" ({shot_copy})' in line for line in lines)
    assert any(two in line and f'recovered copy of "Shot 7" ({shot})' in line for line in lines)


def test_17_a_source_in_recently_deleted_is_named_without_its_id(app):
    client, *_ = app
    alpha = _create(client, "Alpha")
    _create(client, "Beta")
    assert client.request("DELETE", f"/api/projects/{alpha}", headers=PERSON,
                          json={"workspaceRevision": _rev(client)}).status_code == 200
    since = main_module.canvas_events.latest
    copy_id = _recover(client, alpha)["project"]["id"]
    assert (_created(since, copy_id)["data"]["sourceName"], _created(since, copy_id)["data"]["sourceProjectId"]) \
        == ("Alpha", None)
    row = next(row for row in client.get("/api/projects", headers=CODEX).json()["projects"] if row["id"] == copy_id)
    assert (row["sourceName"], row["sourceProjectId"]) == ("Alpha", None)


def test_17_a_source_gone_for_good_isnt_named_to_agents(app):
    """The stop rule: agents can't read a project deleted for good, so they
    aren't told its name; the person's tab still reads the recover answer."""
    client, *_ = app
    alpha = _create(client, "Alpha")
    _create(client, "Beta")
    client.request("DELETE", f"/api/projects/{alpha}", headers=PERSON, json={"workspaceRevision": _rev(client)})
    copy_id = _recover(client, alpha)["project"]["id"]
    assert client.delete(f"/api/projects/trash/{alpha}", headers=PERSON).status_code == 200
    row = next(row for row in client.get("/api/projects", headers=CODEX).json()["projects"] if row["id"] == copy_id)
    assert (row["sourceName"], row["sourceProjectId"]) == (None, None)
    since = main_module.canvas_events.latest
    answer = _recover(client, alpha, shown="Alpha")  # the row is gone: the tab says the name it showed
    assert answer["sourceName"] == "Alpha"  # the person's line
    data = _created(since, answer["project"]["id"])["data"]
    assert (data["sourceName"], data["sourceProjectId"]) == (None, None)


# -- item 19: the person's newer result replacing a node's is journaled ---------------------------------

def test_19_a_handoffs_newer_result_is_journaled_as_the_persons(app):
    client, store, *_ = app
    delta, window_a, _b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    main_module.cli_graph.nodes[new]["outputs"] = _text("AGENT")
    main_module.node_result_runs.landed(delta, new, "agent-run", at=time.time() * 1000 - 60_000)
    held = _with_result(window_a, DUP, outputs=_text("TAB-NEW"), state="complete")
    held["runHistory"] = [_record("tab-run", DUP, _text("TAB-NEW"), started=time.time() * 1000)]
    since = main_module.canvas_events.latest
    published: list[str] = []
    original = main_module.publish_action

    def spy(*args, **kwargs):
        published.append(str(args[:1]))
        return original(*args, **kwargs)

    main_module.publish_action = spy
    try:
        assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    finally:
        main_module.publish_action = original
    events = _events("node.result", since)
    assert [(event["nodeId"], event["actor"]["kind"], event["data"]["runId"], event["data"]["projectId"])
            for event in events] == [(new, "person", "tab-run", delta)]
    assert "newer run from run tab-run" in events[0]["summary"]
    assert published == []  # no Agent log line: the person's own


def test_19_nothing_is_journaled_when_nebulas_result_stands(app):
    client, store, *_ = app
    delta, window_a, _b = _delta(client)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    main_module.cli_graph.nodes[new]["outputs"] = _text("AGENT")
    main_module.node_result_runs.landed(delta, new, "agent-run")
    held = _with_result(window_a, DUP, outputs=_text("TAB-OLD"), state="complete")
    held["runHistory"] = [_record("tab-run", DUP, _text("TAB-OLD"), started=time.time() * 1000 - 600_000)]
    since = main_module.canvas_events.latest
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert not _events("node.result", since)


# -- item 21 (GM r32 6): `nebula watch` for a reopen in place ---------------------------------------------

def _replaced(since: int) -> dict:
    return _events("canvas.replaced", since)[-1]


def test_21_a_reopen_with_no_open_proposals_and_one_new_id(app):
    client, *_ = app
    delta, _a, _b = _delta(client)
    since = main_module.canvas_events.latest
    assert _open(client, delta, headers=TAB_A).status_code == 200
    line = format_event(_replaced(since))
    assert "Reopened the open project — node ids kept, 1 node got a Nebula id; run nebula look" in line
    assert "open proposals still open" not in line


def test_21_a_reopen_with_an_open_proposal_and_no_new_ids(app):
    client, *_ = app
    delta = _create(client, "Delta")
    _add_text(client, "delta-1")
    made = client.post("/api/canvas/proposals", headers=CODEX,
                       json={"note": "Retitle", "params": [{"nodeId": "n1", "params": {"value": "agent's"}}]})
    assert made.status_code == 201, made.text
    since = main_module.canvas_events.latest
    assert _open(client, delta, headers=TAB_A).status_code == 200
    line = format_event(_replaced(since))
    assert "Reopened the open project — node ids kept, open proposals still open; run nebula look" in line
    assert "Nebula id" not in line


@pytest.mark.parametrize("count,words", [(1, "1 node got a Nebula id"), (2, "2 nodes got Nebula ids"),
                                         (7, "7 nodes got Nebula ids")])
def test_21_the_count_is_plural(count, words):
    event = {"kind": "canvas.replaced", "at": 0, "summary": "", "actor": {"kind": "agent", "name": "Codex"},
             "data": {"proposalsKept": True, "proposalsOpen": 1, "renumberedCount": count,
                      "renumbered": {f"t{index}": f"n{index + 10}" for index in range(count)}}}
    assert f"Reopened the open project — node ids kept, open proposals still open, {words}; run nebula look" \
        in format_event(event)


# -- docs --------------------------------------------------------------------------------------------------

def test_agent_docs_describe_round_21():
    def flat(text: str) -> str:
        return " ".join(text.split())

    setup = flat((ROOT / "docs/MCP-SETUP.md").read_text())
    skill = flat((ROOT / "skills/nebula/SKILL.md").read_text())
    for text in (setup, skill):
        assert "openHold" in text and "/api/projects/open-hold" in text
        assert "Opening or switching projects is held:" in text
        assert "resultLandedAt" in text and "Equal times keep Nebula's result" in text
        assert "the side with a time wins" in text
        assert "`node.result`" in text
        assert "`sourceName`" in text and "`sourceProjectId`" in text
        assert "deletesKept" in text
        assert "while Nebula hasn't restarted" not in text
    assert "only the person's tab can read" not in setup
