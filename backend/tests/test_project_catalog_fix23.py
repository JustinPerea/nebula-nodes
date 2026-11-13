"""PR #199 fix round 23 (GM r35), Nebula's side.

- A new project refused at the project limit says both numbers and how many
  to delete: the answer's ``projectCount``, ``projectLimit`` and ``deletes``
  beside ``detail`` (agents' text unchanged), for the tab's line "You have
  501 projects and the limit is 500. You can make a new one after you delete
  2 projects." At the limit and past it (a kept save, a restore or an Undo
  of a delete may take the list past it).
- A delete refused by a World Labs recovery record no project's run history
  names says GM's line in addendum 2's shape: "Nebula couldn’t delete
  “Delta brief” because it has a saved World Labs recovery ID. Check the run
  in Marble, then forget that ID in Run History." Agents' text is unchanged.
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main as main_module  # noqa: E402
from services import project_store as store_module  # noqa: E402
from services.project_store import ProjectLimitError  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _create, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix12 import CODEX  # noqa: E402
from tests.test_project_catalog_restore_fix16 import (  # noqa: E402,F401
    KEPT_TAB, _kept_recover, _kept_snapshot, _manager, _recover, _tab, kept_tab)
from tests.test_project_catalog_restore_fix12 import _settles  # noqa: E402
from tests.test_project_catalog_restore_fix21 import _alpha_then_delta, _named, recoveries  # noqa: E402,F401
from tests.test_project_catalog_restore_fix17 import DUP, _open, _rev  # noqa: E402
from tests.test_project_catalog_restore_fix18 import _handoff, _live  # noqa: E402
from tests.test_project_catalog_restore_fix20_review18 import TAB_A, _delta, _record, _text, _with_result  # noqa: E402
from tests.test_project_catalog_restore_fix21 import _fresh_books, _quiet, _restart  # noqa: E402,F401

UNPLACED = ("Nebula couldn’t delete “Delta brief” because it has a saved World Labs recovery ID. "
            "Check the run in Marble, then forget that ID in Run History.")
AGENT_DETAIL = ("Cannot delete n1: it has unresolved World Labs paid state. "
                "Check Marble, then resolve its exact recovery/ambiguity record first.")


def _listed(client) -> int:
    return len(client.get("/api/projects", headers=PERSON).json()["projects"])


def test_a_new_project_at_the_limit_says_the_count_the_limit_and_one_to_delete(app, monkeypatch):
    client, *_ = app
    _create(client, "Alpha")
    _create(client, "Beta")
    monkeypatch.setattr(store_module, "MAX_PROJECTS", _listed(client))
    refused = client.post("/api/projects", headers=PERSON, json={"name": "Gamma"})
    assert refused.status_code == 413, refused.text
    body = refused.json()
    assert body["detail"] == "Project limit reached"  # agents' text, as before
    assert (body["limit"], body["projectCount"], body["projectLimit"], body["deletes"]) == ("projects", 2, 2, 1)


@pytest.mark.parametrize("limit", [2])
def test_past_the_limit_after_a_kept_save_the_next_new_project_says_how_many_to_delete(app, monkeypatch, kept_tab, limit):
    """The person's kept save took the list past the limit (Justin,
    2026-10-31); a new one is refused with the real numbers."""
    client, *_ = app
    source, snapshot = _kept_snapshot(client)
    _create(client, "Echo")
    monkeypatch.setattr(store_module, "MAX_PROJECTS", limit)
    assert _kept_recover(client, source, snapshot).status_code == 200
    count = _listed(client)
    assert count > limit
    refused = client.post("/api/projects", headers=PERSON, json={"name": "Foxtrot"})
    assert refused.status_code == 413, refused.text
    body = refused.json()
    assert (body["projectCount"], body["projectLimit"], body["deletes"]) == (count, limit, count - limit + 1)


def test_the_stores_own_refusal_counts_the_list_as_read_and_what_it_adds(tmp_path, monkeypatch):
    """A write the store refuses for the limit (any route that adds
    projects) carries the list as the hold read it and how many to delete."""
    store = store_module.ProjectStore(tmp_path / "projects")
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 2)
    with store.transaction() as catalog:
        for index in range(2):
            pid = f"{index:032x}"
            catalog["projects"][pid] = _bare(pid)
        store.commit(catalog)
    with store.transaction() as catalog:
        for pid in ("a" * 32, "b" * 32):
            catalog["projects"][pid] = _bare(pid)
        with pytest.raises(ProjectLimitError) as refused:
            store.commit(catalog)
    assert (refused.value.limit, refused.value.project_count, refused.value.deletes) == ("projects", 2, 2)


def _bare(pid: str) -> dict:
    return {"id": pid, "name": pid[:4], "createdAt": store_module.now(), "updatedAt": store_module.now(),
            "snapshot": store_module.empty_snapshot()}


def _delete(client, headers=PERSON):
    return client.request("DELETE", "/api/graph/node/n1",
                          headers={**headers, "X-Nebula-Workspace-Revision": _rev(client)})


def test_a_record_no_run_history_names_says_gms_line_and_agents_text_is_unchanged(app, recoveries):
    client, *_ = app
    _alpha_then_delta(client)
    _named("Delta brief")
    recoveries.set(run_id="wl-run-nowhere", node_id="n1", resume_operation_id="op-nobody", existing_world_id=None)
    refused = _delete(client)
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"] == UNPLACED
    agent = _delete(client, CODEX)
    assert agent.status_code == 409 and agent.json()["detail"] == AGENT_DETAIL
    assert "n1" in main_module.cli_graph.nodes


def test_the_unplaced_line_names_the_node_by_the_name_helper(app, recoveries):
    client, *_ = app
    _alpha_then_delta(client)
    main_module.cli_graph.set_label("n1", "")
    recoveries.set(run_id="wl-run-nowhere", node_id="n1", resume_operation_id="op-nobody", existing_world_id=None)
    refused = _delete(client)
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"] == UNPLACED.replace("“Delta brief”", main_module._quoted(main_module._node_label("n1")))
    assert "Delta brief" not in refused.json()["detail"]


def test_when_nebula_cant_tell_the_open_project_the_records_own_line_stays(app, recoveries, monkeypatch):
    """No claim about where a record is when the live canvas isn't the open
    project's: the person's line is the record's own (fail closed)."""
    client, *_ = app
    _alpha_then_delta(client)
    recoveries.set(run_id="wl-run-nowhere", node_id="n1", resume_operation_id="op-nobody", existing_world_id=None)
    holding = recoveries.list()
    assert main_module._shared_id_delete_person("n1", holding) == UNPLACED.replace(
        "“Delta brief”", main_module._quoted(main_module._node_label("n1")))
    with monkeypatch.context() as m:
        m.setattr(main_module.cli_graph, "owner", "someone-else")
        assert main_module._shared_id_delete_person("n1", holding) is None
    with monkeypatch.context() as m:
        m.setattr(main_module, "_catalog_for_the_hold", lambda: {})
        assert main_module._shared_id_delete_person("n1", holding) is None


# -- A kept save passes the limit by one, from a tab Nebula knows keeps edits (RD LOW-2) --------

def _over_limit_body(count: int, limit: int, deletes: int) -> dict:
    return {"detail": "Project limit reached", "limit": "projects", "projectLimit": limit,
            "projectCount": count, "deletes": deletes}


def test_repeated_kept_saves_stop_at_the_limit_plus_one(app, monkeypatch, kept_tab):
    """The first kept save takes the list over by one; the next (a new
    recoveryId) is refused like a new project, with the numbers for the tab's
    line, and the list stays at limit + 1."""
    client, *_ = app
    source, snapshot = _kept_snapshot(client)
    _create(client, "Echo")
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 2)
    first = _kept_recover(client, source, snapshot, recovery_id="a" * 32)
    assert first.status_code == 200, first.text
    assert _listed(client) == 3
    for index, recovery_id in enumerate(("b" * 32, "c" * 32)):
        refused = _kept_recover(client, source, snapshot, recovery_id=recovery_id)
        assert refused.status_code == 413, refused.text
        # Three projects, a fourth wanted: delete 2 and it fits under 2.
        assert refused.json() == _over_limit_body(3, 2, 2)
        assert _listed(client) == 3
    # The first save's retry still answers as it did (no second copy).
    again = _kept_recover(client, source, snapshot, recovery_id="a" * 32)
    assert again.status_code == 200 and again.json()["project"]["id"] == first.json()["project"]["id"]
    assert _listed(client) == 3


def test_a_kept_save_at_the_limit_from_a_kept_tab_passes_by_one_and_says_one_to_delete_otherwise(app, monkeypatch, kept_tab):
    client, *_ = app
    source, snapshot = _kept_snapshot(client)
    monkeypatch.setattr(store_module, "MAX_PROJECTS", _listed(client))
    passed = _kept_recover(client, source, snapshot)
    assert passed.status_code == 200, passed.text
    assert _listed(client) == store_module.MAX_PROJECTS + 1


@pytest.mark.parametrize("tab", ["not-a-kept-tab", None], ids=["another tab", "no tab"])
def test_a_person_request_with_kept_true_from_a_tab_that_isnt_keeping_edits_is_refused(app, monkeypatch, kept_tab, tab):
    """kept: true is the tab's word; Nebula passes the limit only for a tab it
    knows keeps edits. Refused like a new project (limit 2, two projects: a
    third is wanted, delete 1)."""
    client, *_ = app
    source, snapshot = _kept_snapshot(client)
    _create(client, "Echo")
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 2)
    refused = _kept_recover(client, source, snapshot, tab=tab)
    assert refused.status_code == 413, refused.text
    assert refused.json() == _over_limit_body(2, 2, 1)
    assert _listed(client) == 2


def test_no_tab_is_kept_when_none_said_so(app, monkeypatch):
    client, *_ = app
    source, snapshot = _kept_snapshot(client)
    _create(client, "Echo")
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 2)
    assert not main_module.manager.kept_tabs
    refused = _kept_recover(client, source, snapshot)
    assert refused.status_code == 413 and refused.json() == _over_limit_body(2, 2, 1)


@pytest.mark.parametrize("with_tab", [True, False], ids=["the kept tab's id", "no tab"])
def test_an_agent_is_refused_at_the_limit_as_before_even_naming_the_kept_tab(app, monkeypatch, kept_tab, with_tab):
    client, *_ = app
    source, snapshot = _kept_snapshot(client)
    _create(client, "Echo")
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 2)
    refused = _kept_recover(client, source, snapshot, headers=CODEX, tab=KEPT_TAB if with_tab else None)
    assert refused.status_code == 413, refused.text
    assert refused.json() == _over_limit_body(2, 2, 1)
    assert _listed(client) == 2


def test_the_tab_says_it_keeps_edits_on_its_socket_and_a_save_from_it_passes(app, monkeypatch, tmp_path):
    """Through the real socket: the keptEdits frame carries the tab's id
    (X-Nebula-Tab). A frame without it, or after kept:false, or from a
    closed socket, doesn't make a tab Nebula knows keeps edits."""
    client, *_ = app
    manager = _manager(monkeypatch, tmp_path / main_module.KEPT_MARKER_NAME)
    source, snapshot = _kept_snapshot(client)
    _create(client, "Echo")
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 2)
    socket, tab = _tab(client)
    try:
        tab.send_json({"type": "keptEdits", "kept": True})  # no id
        assert _settles(lambda: len(manager.kept_tabs) == 1)
        assert not manager.is_kept_tab(KEPT_TAB)
        assert _kept_recover(client, source, snapshot).status_code == 413
        tab.send_json({"type": "keptEdits", "kept": True, "tab": "bad id with spaces"})
        assert _settles(lambda: not manager.kept_tab_ids)
        tab.send_json({"type": "keptEdits", "kept": True, "tab": KEPT_TAB})
        assert _settles(lambda: manager.is_kept_tab(KEPT_TAB))
        assert not manager.is_kept_tab("another-tab-0002")
        assert _kept_recover(client, source, snapshot, tab="another-tab-0002").status_code == 413
        assert _kept_recover(client, source, snapshot).status_code == 200
        tab.send_json({"type": "keptEdits", "kept": False, "tab": KEPT_TAB})
        assert _settles(lambda: not manager.is_kept_tab(KEPT_TAB))
        assert _kept_recover(client, source, snapshot, recovery_id="d" * 32).status_code == 413
        tab.send_json({"type": "keptEdits", "kept": True, "tab": KEPT_TAB})
        assert _settles(lambda: manager.is_kept_tab(KEPT_TAB))
    finally:
        socket.__exit__(None, None, None)
    assert _settles(lambda: not manager.is_kept_tab(KEPT_TAB) and not manager.kept_tab_ids)


def _frames_seen(monkeypatch, manager) -> list:
    """Counts the keptEdits frames the server has handled, so a test can wait
    for a frame whose effect is "nothing changed"."""
    seen: list = []
    real = manager.set_kept

    def counted(*args, **kwargs):
        real(*args, **kwargs)
        seen.append(args[1:])

    monkeypatch.setattr(manager, "set_kept", counted)
    return seen


@pytest.mark.parametrize("frame", [{"kept": True}, {"kept": True, "tab": "bad id with spaces"},
                                   {"kept": True, "tab": "x" * 65}, {"kept": False, "tab": KEPT_TAB}],
                         ids=["no id", "an id with spaces", "an id too long", "kept false"])
def test_the_tabs_latest_frame_names_it_a_frame_without_a_good_id_forgets_the_old_one(app, monkeypatch, tmp_path, frame):
    """Nebula knows a kept tab by the id its latest keptEdits frame named. A
    frame with no id, or one X-Nebula-Tab could never carry, forgets the id
    the tab said before (it's not kept back under it), and none is stored."""
    client, *_ = app
    manager = _manager(monkeypatch, tmp_path / main_module.KEPT_MARKER_NAME)
    seen = _frames_seen(monkeypatch, manager)
    source, snapshot = _kept_snapshot(client)
    _create(client, "Echo")
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 2)
    socket, tab = _tab(client)
    try:
        tab.send_json({"type": "keptEdits", "kept": True, "tab": KEPT_TAB})
        assert _settles(lambda: manager.is_kept_tab(KEPT_TAB))
        tab.send_json({"type": "keptEdits", **frame})
        assert _settles(lambda: len(seen) == 2)
        assert manager.kept_tab_ids == {}
        assert not manager.is_kept_tab(KEPT_TAB)
        assert _kept_recover(client, source, snapshot).status_code == 413
        if frame["kept"] is False:
            # Kept again with no id: the old one doesn't come back.
            tab.send_json({"type": "keptEdits", "kept": True})
            assert _settles(lambda: len(seen) == 3)
            assert manager.kept_tabs and manager.kept_tab_ids == {}
            assert _kept_recover(client, source, snapshot).status_code == 413
    finally:
        socket.__exit__(None, None, None)


REKEYED_TAB = "kept-tab-0002"


def test_a_kept_tab_that_takes_a_new_id_on_the_same_socket_is_known_by_the_new_one_only(app, monkeypatch, tmp_path):
    """A page back from the back-forward cache takes a new tab id and says
    keptEdits again under it. Nebula knows the tab by the new id from then
    on: the old one no longer passes the limit, and the tab is still one kept
    tab (no second one, no grace taken)."""
    client, *_ = app
    manager = _manager(monkeypatch, tmp_path / main_module.KEPT_MARKER_NAME)
    source, snapshot = _kept_snapshot(client)
    _create(client, "Echo")
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 2)
    socket, tab = _tab(client)
    try:
        tab.send_json({"type": "keptEdits", "kept": True, "tab": KEPT_TAB})
        assert _settles(lambda: manager.is_kept_tab(KEPT_TAB))
        tab.send_json({"type": "keptEdits", "kept": True, "tab": REKEYED_TAB})
        assert _settles(lambda: manager.is_kept_tab(REKEYED_TAB))
        assert not manager.is_kept_tab(KEPT_TAB)
        assert len(manager.kept_tabs) == 1 and list(manager.kept_tab_ids.values()) == [REKEYED_TAB]
        assert manager.kept_count() == 1
        assert _kept_recover(client, source, snapshot, tab=KEPT_TAB).status_code == 413
        assert _kept_recover(client, source, snapshot, tab=REKEYED_TAB).status_code == 200
    finally:
        socket.__exit__(None, None, None)
    assert _settles(lambda: not manager.kept_tab_ids)


def test_a_kept_tab_back_on_a_new_socket_under_a_new_id_is_known_by_the_new_one_only(app, monkeypatch, tmp_path):
    """The bfcache closes the page's socket: the old one goes (its id with
    it, a grace held), the page comes back on a new socket with a new id and
    takes that grace over."""
    client, *_ = app
    manager = _manager(monkeypatch, tmp_path / main_module.KEPT_MARKER_NAME)
    source, snapshot = _kept_snapshot(client)
    _create(client, "Echo")
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 2)
    first, tab = _tab(client)
    try:
        tab.send_json({"type": "keptEdits", "kept": True, "tab": KEPT_TAB})
        assert _settles(lambda: manager.is_kept_tab(KEPT_TAB))
    finally:
        first.__exit__(None, None, None)
    assert _settles(lambda: not manager.is_kept_tab(KEPT_TAB) and len(manager.kept_graces) == 1)
    assert _kept_recover(client, source, snapshot, tab=KEPT_TAB).status_code == 413
    second, tab = _tab(client)
    try:
        tab.send_json({"type": "keptEdits", "kept": True, "tab": REKEYED_TAB})
        assert _settles(lambda: manager.is_kept_tab(REKEYED_TAB))
        assert not manager.is_kept_tab(KEPT_TAB) and not manager.kept_graces
        assert _kept_recover(client, source, snapshot, tab=KEPT_TAB).status_code == 413
        assert _kept_recover(client, source, snapshot, tab=REKEYED_TAB).status_code == 200
    finally:
        second.__exit__(None, None, None)


# -- The recover route's own numbers (B6)------------------------------------------------------

def test_the_recover_routes_413_carries_the_count_and_how_many_to_delete_when_the_store_gave_none(app, monkeypatch):
    """The route fills in what a refusal from the store lacks: the list it
    holds minus the copy it added, and how many to delete to fit."""
    client, *_ = app
    source, snapshot = _kept_snapshot(client)
    _create(client, "Echo")
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 2)

    def refuse(catalog, **_):
        raise ProjectLimitError("Project limit reached", "projects")

    monkeypatch.setattr(main_module.project_store, "commit", refuse)
    refused = _recover(client, source, snapshot)
    assert refused.status_code == 413, refused.text
    assert refused.json() == _over_limit_body(2, 2, 1)


def test_the_recover_routes_413_at_and_past_the_limit_carries_the_numbers(app, monkeypatch):
    client, *_ = app
    source, snapshot = _kept_snapshot(client)
    _create(client, "Echo")
    _create(client, "Foxtrot")
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 2)  # three projects, over by one
    refused = _recover(client, source, snapshot)
    assert refused.status_code == 413, refused.text
    assert refused.json() == _over_limit_body(3, 2, 2)


# -- A Cinema shot's merge stamps the landing (reopen-tabs NIT-4) -----------------------------

IMAGE = {"type": "Image", "value": "/nebula-shot.png"}


def _merge_result(node_id: str):
    return main_module._merge_shot_result(node_id, "s1", None, {"shot_s1": IMAGE}, run_id="cinema-run")


def _merge_failure(node_id: str):
    return main_module._merge_shot_result(node_id, "s1", None, {}, terminal_error="the shot failed", run_id="cinema-run")


def _merge_variations(node_id: str):
    return main_module._merge_shot_variations(node_id, "s1", [{"url": "/nebula-shot.png", "seed": 1}], run_id="cinema-run")


@pytest.mark.parametrize("merge", [_merge_result, _merge_failure, _merge_variations],
                         ids=["result", "failure", "variations"])
def test_a_cinema_shot_merge_stamps_when_its_result_landed_and_a_tabs_older_result_loses_after_a_restart(app, monkeypatch, merge):
    """A shot's merge writes the node's outputs without an executed event.
    It stamps the landing as every run result does, so after a restart (the
    in-memory landings gone) the tab's handoff with an older run's result
    doesn't win by default."""
    client, store, _graph, state_path = app
    _quiet(monkeypatch)
    delta, window_a, _b = _delta(client)
    now = time.time() * 1000
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    before = time.time() * 1000
    asyncio.run(merge(new))
    stamp = main_module.cli_graph.nodes[new][main_module.RESULT_LANDED_KEY]
    assert before <= stamp <= time.time() * 1000
    # In memory and on disk (state.json), so a restart still has it.
    assert main_module.node_result_runs.entries(delta, new)[-1]["runId"] == "cinema-run"
    _restart(state_path)
    assert main_module.cli_graph.nodes[new][main_module.RESULT_LANDED_KEY] == stamp
    assert main_module.node_result_runs.entries(delta, new) == []
    nebulas = dict(main_module.cli_graph.nodes[new].get("outputs") or {})
    held = _with_result(window_a, DUP, outputs=_text("TAB-OLD"), state="complete")
    held["runHistory"] = [_record("tab-run", DUP, _text("TAB-OLD"), started=now - 120_000)]
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    live = _live(client)[new]["data"]["outputs"]
    assert live != _text("TAB-OLD")
    assert live == nebulas
