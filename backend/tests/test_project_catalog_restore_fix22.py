"""PR #199 fix round 22: review 20's backend items and GM r34.

- reopen-verdict LOW-5 / agents-docs main LOW (GM r34 A1): the person's
  refusal line for a whole-canvas replacement (the open, Clear canvas,
  Create, a graph replace, a bundle restore) places the held record as the
  hold does: "“World” from “Alpha”" for another project's record, "A World
  Labs Environment node" when the project can't be known, never the live
  canvas's node that only shares the id.
- reopen-verdict LOW-1: the landing stamp loads with the node at an open,
  and a save keeps the stored stamp while the result is the one stored.
- reopen-verdict NIT-1 / agents-docs LOW-2: the read of the hold and the
  press agree on bootstrap (the read tries the same journal write), and a
  fenced refusal says bootstrap in its detail, code and hold.
- reopen-verdict NIT-2: a tab's run record dates each node's result by
  ``nodeLandedAt``.
- reopen-verdict NIT-6 / agents-docs NIT-1: mutants V5 (A3), V9 (A9), V14,
  A18 and A21.
- agents-docs LOW-1 and NIT-2: a real paid start's open 409, and
  new_project's 409, carry ``hold`` with the same action words.
- agents-docs LOW-3, LOW-4, LOW-5, NIT-3: the tool descriptions, the event
  table, the agents' note, and what a read can persist.
- The export's, the graph read's and graphSync's ``providerRecoveries`` /
  ``providerStartAmbiguities`` are pinned (unchanged from 69277f89).
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import stat
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
from models.events import ExecutedEvent  # noqa: E402
from nebula_api import NebulaAPI  # noqa: E402
from services.node_result_runs import NodeResultRuns  # noqa: E402
from services.provider_recovery import ProviderRecoveryStore  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_graph_recovery_bootstrap_retry import _bundle  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _add_text, _create, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix12 import CODEX  # noqa: E402
from tests.test_project_catalog_restore_fix17 import DUP, _open, _rev, _stored  # noqa: E402
from tests.test_project_catalog_restore_fix18 import _handoff, _live  # noqa: E402
from tests.test_project_catalog_restore_fix20_review18 import (  # noqa: E402
    TAB_A, TAB_B, _copy, _delta, _disk_node, _record, _save, _syncs, _text, _with_result)
from tests.test_project_catalog_restore_fix21 import (  # noqa: E402,F401
    _alpha_then_delta, _fresh_books, _hold, _lands, _quiet, _restart, _stamp_stored, _switched_away,
    recoveries)

ROOT = Path(__file__).resolve().parent.parent.parent
ENVIRONMENT = "worldlabs-environment"
TAIL = "has a saved World Labs recovery ID. Check the run in Marble, then forget the ID in Run History."


# -- A. the person's line places the record as the hold does (GM r34 A1) ----------------------------

def _press(client, surface: str, headers=PERSON):
    """One whole-canvas replacement, as the person's tab sends it."""
    moved = {**headers, "X-Nebula-Workspace-Revision": _rev(client)}
    if surface == "open":
        project = client.get("/api/projects", headers=PERSON).json()["activeProjectId"]
        return _open(client, project, headers=headers)
    if surface == "clear":
        return client.request("DELETE", "/api/graph?force=true", headers=moved)
    if surface == "create":
        return client.post("/api/projects", headers=headers, json={"name": "New", "workspaceRevision": _rev(client)})
    if surface == "import":
        return client.post("/api/graph/import", headers=moved, json={"nodes": [], "edges": []})
    assert surface == "restore"
    return client.post("/api/outputs/restore", content=_bundle(), headers={**headers, "content-type": "application/zip"})


SURFACES = ["open", "clear", "create", "import", "restore"]


@pytest.mark.parametrize("surface", SURFACES)
@pytest.mark.parametrize("record,subject", [
    # Alpha's n1 "World" (its run history has the run); Delta is open, its own n1 "Delta World".
    ({"run_id": "wl-run-alpha", "resume_operation_id": "op-1"}, "“World” from “Alpha”"),
    # Delta's own record: as before round 22.
    ({"run_id": "wl-run-delta", "resume_operation_id": "op-1"}, "“Delta World”"),
    # No project's run history has it, and no stored node holds its ID: the project can't be known.
    # An Existing World ID is only a World Labs Environment node's.
    ({"run_id": "wl-run-ghost", "existing_world_id": "world-1"}, "A World Labs Environment node"),
    # ... and with only an operation ID the type can't be known either.
    ({"run_id": "wl-run-ghost", "resume_operation_id": "op-1"}, "A World Labs node"),
])
def test_a_the_persons_line_names_the_held_record_where_it_belongs(app, recoveries, surface, record, subject):
    client, *_ = app
    _alpha_then_delta(client)
    recoveries.set(node_id="n1", **{"resume_operation_id": None, "existing_world_id": None, **record})
    refused = _press(client, surface)
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"] == f"{subject} {TAIL}"
    # Agents keep the specific text, which names no node.
    agent = _press(client, surface, CODEX)
    assert agent.status_code == 409 and "“" not in agent.json()["detail"]


def test_a_a_node_alphas_snapshot_no_longer_names_is_said_by_its_type_from_alpha(app, recoveries):
    client, store, *_ = app
    alpha, _delta_id = _alpha_then_delta(client)
    with store.transaction() as catalog:
        node = catalog["projects"][alpha]["snapshot"]["nodes"][0]
        node["id"] = "n7"  # Alpha's n1 is gone; its run history still names the run
        store.commit(catalog)
    recoveries.set(run_id="wl-run-alpha", node_id="n1", resume_operation_id=None, existing_world_id="world-1")
    refused = _press(client, "clear")
    assert refused.json()["detail"] == f"A World Labs Environment node from “Alpha” {TAIL}"


def test_a_the_open_keeps_the_hold_and_its_line_agrees(app, recoveries):
    client, *_ = app
    alpha, delta = _alpha_then_delta(client)
    recoveries.set(run_id="wl-run-alpha", node_id="n1", resume_operation_id="op-1", existing_world_id=None)
    body = _open(client, delta, headers=PERSON).json()
    assert body["detail"] == f"“World” from “Alpha” {TAIL}"
    assert (body["hold"]["nodeName"], body["hold"]["projectId"], body["hold"]["projectName"]) == ("World", alpha, "Alpha")


# -- B. the landing stamp across an open; a node's own landing time (nodeLandedAt) ----------------

def test_b1_the_stamp_survives_an_open_an_autosave_and_a_restart(app, monkeypatch):
    """Review 20's probe (stamp lost across an open then restart): the agent's
    run lands on n1; an agent reopens Delta; window B autosaves; Nebula
    restarts; tab A hands off an hour-old result. Nebula's stands."""
    client, store, _graph, state_path = app
    _quiet(monkeypatch)
    delta = _create(client, "Delta")
    _add_text(client, "delta-1")
    window_a = _stored(client, delta)
    old_rev = _rev(client)
    _lands("n1", "AGENT-LATER", "agent-run")
    stamp = main_module.cli_graph.nodes["n1"][main_module.RESULT_LANDED_KEY]
    assert _open(client, delta, headers=CODEX).status_code == 200
    assert main_module.cli_graph.nodes["n1"][main_module.RESULT_LANDED_KEY] == stamp
    _save(client, delta, _stored(client, delta), headers=TAB_B)
    assert _disk_node(store, delta, "n1")["data"][main_module.RESULT_LANDED_KEY] == stamp
    _restart(state_path)
    held = _with_result(window_a, "n1", outputs=_text("TAB-OLDER"), state="complete")
    held["runHistory"] = [_record("tab-run", "n1", _text("TAB-OLDER"), started=time.time() * 1000 - 3_600_000)]
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert _disk_node(store, delta, "n1")["data"]["outputs"] == _text("AGENT-LATER")
    assert _live(client)["n1"]["data"]["outputs"] == _text("AGENT-LATER")


@pytest.mark.parametrize("changed,kept", [(False, True), (True, False)])
def test_b1_a_save_keeps_the_stored_stamp_while_its_result_is_the_one_stored(app, monkeypatch, changed, kept):
    """The live node lost its stamp (a canvas read back from an older
    state.json): a save keeps the stored one while the node's result is the
    one stored, and drops it once the result isn't."""
    client, store, *_ = app
    _quiet(monkeypatch)
    delta = _create(client, "Delta")
    _add_text(client, "delta-1")
    _lands("n1", "RAN", "run-1")
    _stored(client, delta)  # the stored copy gets the stamp from the live node
    stamp = main_module.cli_graph.nodes["n1"].pop(main_module.RESULT_LANDED_KEY)
    assert _disk_node(store, delta, "n1")["data"][main_module.RESULT_LANDED_KEY] == stamp
    snapshot = _copy(_stored(client, delta))
    if changed:
        snapshot["nodes"][0]["data"]["outputs"] = _text("ELSE")
    _save(client, delta, snapshot)
    got = _disk_node(store, delta, "n1")["data"].get(main_module.RESULT_LANDED_KEY)
    assert got == (stamp if kept else None)


def _long_run(node_id: str, started: float, landed: float | None) -> dict:
    """A ten-minute run record whose result on ``node_id`` landed at ``landed``."""
    record = _record("tab-long-run", node_id, _text("TAB"), started=started, took=600.0)
    if landed is not None:
        record["nodeLandedAt"] = {node_id: landed}
    return record


@pytest.mark.parametrize("landed_after,expected", [(10_000, "NEBULA"), (120_000, "TAB"), (None, "TAB")])
def test_b5_a_long_runs_early_result_loses_to_a_result_that_landed_mid_run(app, landed_after, expected):
    """After a restart (no landing seen in this process): the tab's long run
    started at T, its result on n1 landed at T+10 s; Nebula's (an agent's)
    landed at T+60 s. Nebula's stands. Without ``nodeLandedAt`` the run's
    end (T+600 s) is the tab's time, as before."""
    client, store, *_ = app
    delta, old_rev, window_a = _switched_away(client)
    started = time.time() * 1000 - 3_600_000
    _stamp_stored(store, client, delta, "n1", started + 60_000, _text("NEBULA"))
    main_module.node_result_runs = NodeResultRuns()  # a restart
    held = _with_result(window_a, "n1", outputs=_text("TAB"), state="complete")
    held["runHistory"] = [_long_run("n1", started, None if landed_after is None else started + landed_after)]
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert _disk_node(store, delta, "n1")["data"]["outputs"] == _text(expected)


def test_b5_node_landed_at_moves_with_a_renumbered_node(app, monkeypatch):
    """The tab's record keys the duplicate by its tab-local id; the agent's
    reopen gives it n2. The handoff reads the record under n2 (its keys
    moved with the node), so the run's early landing loses to the agent's
    landing mid-run; and the stored record is keyed by n2 too."""
    client, store, _graph, state_path = app
    _quiet(monkeypatch)
    delta, window_a, _b = _delta(client)
    started = time.time() * 1000 - 600_000
    saved = _copy(window_a)
    saved["runHistory"] = [_long_run(DUP, started, started + 10_000)]
    _save(client, delta, saved)
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    stored = _stored(client, delta)
    assert stored["runHistory"][0]["nodeLandedAt"] == {new: started + 10_000}
    _lands(new, "AGENT", "agent-run")
    main_module.cli_graph.nodes[new][main_module.RESULT_LANDED_KEY] = started + 60_000  # it landed mid-run
    main_module.cli_graph._maybe_persist()
    _restart(state_path)
    assert main_module.cli_graph.nodes[new][main_module.RESULT_LANDED_KEY] == started + 60_000
    held = _with_result(saved, DUP, outputs=_text("TAB"), state="complete")
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert _live(client)[new]["data"]["outputs"] == _text("AGENT")


# -- C. bootstrap: the read and the press agree, with the real retry ------------------------------

def _journal_in(monkeypatch, directory: Path) -> ProviderRecoveryStore:
    directory.mkdir(exist_ok=True)
    store = ProviderRecoveryStore(directory / "provider-recoveries.json")
    monkeypatch.setattr(main_module, "provider_recovery_store", store)
    return store


@pytest.mark.unprivileged
def test_c_bootstrap_while_the_journal_cant_be_written_says_bootstrap_everywhere(app, tmp_path, monkeypatch):
    client, *_ = app
    delta = _create(client, "Delta")
    folder = tmp_path / "journal"
    store = _journal_in(monkeypatch, folder)
    store.list()
    os.chmod(folder, stat.S_IRUSR | stat.S_IXUSR)
    try:
        monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", "journal unwritable at boot")
        specific = main_module._graph_bootstrap_specific("switch projects")
        hold = _hold(client, CODEX)
        assert (hold["state"], hold["detail"]) == ("bootstrap", specific)
        for refused in (_open(client, delta, headers=CODEX),
                        client.post("/api/projects", headers=CODEX, json={"name": "N", "workspaceRevision": _rev(client)})):
            body = refused.json()
            assert refused.status_code == 409
            assert (body["detail"], body["code"], body["hold"]) == (specific, "paid_bootstrap", hold)
        person = _open(client, delta, headers=PERSON).json()
        assert (person["detail"], person["code"]) == (main_module.WORLD_LABS_BOOTSTRAP_PERSON, "paid_bootstrap")
        clear = _press(client, "clear", CODEX).json()
        assert (clear["code"], clear["detail"]) == (
            "paid_bootstrap", main_module._graph_bootstrap_specific("clear the canvas"))
    finally:
        os.chmod(folder, stat.S_IRWXU)
    # The journal takes a write again: the read says so, and the press goes.
    assert _hold(client, CODEX) is None
    assert _open(client, delta, headers=CODEX).status_code == 200


def test_c_a_journal_that_takes_the_write_never_reads_as_held(app, tmp_path, monkeypatch):
    """The bootstrap error is set, but the journal takes a write now: the
    read answers what the press does (it goes), never "held"."""
    client, *_ = app
    delta = _create(client, "Delta")
    _journal_in(monkeypatch, tmp_path / "journal")
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", "journal unwritable at boot")
    listed = client.get("/api/projects", headers=CODEX).json()
    assert listed["openHold"] is None
    assert main_module._graph_recovery_bootstrap_error is None
    assert _open(client, delta, headers=CODEX).status_code == 200


# -- D. a real paid start: the open's and new_project's 409 carry the hold -------------------------

def test_d_a_real_paid_start_refuses_the_open_and_new_project_with_the_hold(app):
    client, *_ = app
    delta = _create(client, "Delta")
    guard = main_module.provider_start_guard
    guard.claim(run_id="wl-live", claims=[(ENVIRONMENT, "n9")])
    try:
        hold = _hold(client, CODEX)
        assert hold["state"] == "active" and hold["detail"] == main_module._graph_settling_specific("switch projects")
        for refused in (_open(client, delta, headers=CODEX),
                        client.post("/api/projects", headers=CODEX, json={"name": "N", "workspaceRevision": _rev(client)})):
            body = refused.json()
            assert refused.status_code == 409
            assert (body["detail"], body["code"], body["hold"]) == (hold["detail"], "paid_start", hold)
        person = _open(client, delta, headers=PERSON).json()
        assert person["detail"] == main_module.WORLD_LABS_STARTING_PERSON and person["hold"] == hold
    finally:
        guard.release_run("wl-live")
    assert _open(client, delta, headers=CODEX).status_code == 200


def test_d_new_project_under_a_recovery_carries_the_hold(app, recoveries):
    client, *_ = app
    alpha, _delta_id = _alpha_then_delta(client)
    recoveries.set(run_id="wl-run-alpha", node_id="n1", resume_operation_id="op-1", existing_world_id=None)
    made = client.post("/api/projects", headers=CODEX, json={"name": "N", "workspaceRevision": _rev(client)})
    assert made.status_code == 409
    assert made.json()["hold"] == _hold(client, CODEX)
    assert made.json()["hold"]["projectId"] == alpha


# -- E. mutants V5 (A3), V9 (A9), V14, A18, A21 ------------------------------------------------------

def _hold_the_id(store, project_id: str, operation: str) -> None:
    """The project's stored n1 is a World Labs Environment node whose settings hold ``operation``."""
    with store.transaction() as catalog:
        data = catalog["projects"][project_id]["snapshot"]["nodes"][0]["data"]
        data["definitionId"] = ENVIRONMENT
        data["params"] = {"resume_operation_id": operation}
        store.commit(catalog)


def test_v5_a3_an_id_two_projects_hold_places_neither(app, recoveries):
    """A seeded record (no run history names it) whose ID two projects'
    nodes hold (a duplicate copies it): its project can't be known."""
    client, store, *_ = app
    alpha = _create(client, "Alpha")
    _add_text(client, "a")
    beta = _create(client, "Beta")
    _add_text(client, "b")
    _create(client, "Delta")
    _add_text(client, "d")
    _hold_the_id(store, alpha, "op-dup")
    recoveries.set(run_id="graph-mutation-preflight-x", node_id="n1", resume_operation_id="op-dup",
                   existing_world_id=None)
    _hold_the_id(store, beta, "op-dup")
    hold = _hold(client)
    assert (hold["state"], hold["projectId"], hold["nodeName"]) == ("recovery", None, None)
    assert _press(client, "clear").json()["detail"] == f"A World Labs node {TAIL}"
    # One holder: it is placed.
    _hold_the_id(store, beta, "op-other")
    assert _hold(client)["projectId"] == alpha


def test_v9_a9_a_handoff_never_keeps_the_tabs_stamp_on_a_node_only_the_tab_has(app):
    client, store, *_ = app
    delta, old_rev, window_a = _switched_away(client)
    held = _copy(window_a)
    next(node for node in held["nodes"] if node["id"] == DUP)["data"][main_module.RESULT_LANDED_KEY] = \
        time.time() * 1000
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert main_module.RESULT_LANDED_KEY not in _disk_node(store, delta, DUP)["data"]


def test_v14_the_later_of_the_stored_and_live_stamps_is_nebulas_time(app):
    """Delta open after an agent's reopen: the stored n1 stamp is older than
    the live one. The tab's run finished between them: the live (later)
    stamp decides, so Nebula's stands."""
    client, store, *_ = app
    delta, window_a, _b = _delta(client)
    old_rev = _rev(client)
    assert _open(client, delta, headers=CODEX).status_code == 200
    now = time.time() * 1000
    _stamp_stored(store, client, delta, "n1", now - 60_000, _text("NEBULA"))
    live = main_module.cli_graph.nodes["n1"]
    live["outputs"] = _text("NEBULA")
    live[main_module.RESULT_LANDED_KEY] = now - 10_000
    held = _with_result(window_a, "n1", outputs=_text("TAB"), state="complete")
    held["runHistory"] = [_record("tab-run", "n1", _text("TAB"), started=now - 31_000, took=1.0)]
    assert _handoff(client, delta, old_rev, held, headers=TAB_A).status_code == 200
    assert _disk_node(store, delta, "n1")["data"]["outputs"] == _text("NEBULA")


def test_a18_a_landing_in_another_projects_run_never_stamps_the_open_canvas(app, monkeypatch):
    """A run admitted in Alpha lands on its n1 after Delta opened: Delta's
    live n1 (same id) gets no stamp."""
    client, *_ = app
    alpha = _create(client, "Alpha")
    _add_text(client, "a")
    _create(client, "Delta")
    _add_text(client, "d")
    token = main_module._execution_workspace_context.set({"activeProjectId": alpha, "workspaceRevision": "alpha-rev"})
    try:
        main_module._note_result_landed(ExecutedEvent(node_id="n1", outputs=_text("A"), run_id="alpha-run"),
                                        "alpha-run")
    finally:
        main_module._execution_workspace_context.reset(token)
    assert main_module.RESULT_LANDED_KEY not in main_module.cli_graph.nodes["n1"]
    assert [entry["runId"] for entry in main_module.node_result_runs.entries(alpha, "n1")] == ["alpha-run"]


@pytest.mark.parametrize("owned,expected", [(True, "delta"), (False, None)])
def test_a21_the_live_canvas_places_a_seeded_record_only_while_it_is_the_open_projects(app, recoveries, owned, expected):
    client, *_ = app
    delta = _create(client, "Delta")
    _add_text(client, "d")
    live = main_module.cli_graph.nodes["n1"]
    live["definitionId"] = ENVIRONMENT
    live["params"] = {"resume_operation_id": "op-live"}
    recoveries.set(run_id="graph-mutation-preflight-y", node_id="n1", resume_operation_id="op-live",
                   existing_world_id=None)
    if not owned:
        main_module.cli_graph.owner = None  # the live canvas isn't Delta's (a canvas waiting to be filed)
    hold = main_module._graph_replacement_hold()
    assert hold["projectId"] == (delta if expected else None)


# -- F. agents: the note, the tool descriptions and the docs ---------------------------------------

def _agents_note(client) -> tuple[str, str]:
    listed = project_client.list_projects(NebulaAPI("http://testserver", client=client), headers=CODEX)
    cli = NebulaClient("http://testserver")
    cli._client = client
    out = io.StringIO()
    with redirect_stdout(out):
        projects_cmd.run_list(cli)
    return listed["openHold"]["note"], out.getvalue()


@pytest.mark.parametrize("run_id,said", [
    ("wl-run-alpha", "“World” (n1) from “Alpha”"),
    ("wl-run-delta", "“Delta World” (n1) in the open project “Delta”"),
    ("wl-run-ghost", "a World Labs node (n1), in a project Nebula can\u2019t tell,"),
])
def test_f_the_agents_note_says_the_state_node_project_and_what_clears_it(app, recoveries, run_id, said):
    client, *_ = app
    _alpha_then_delta(client)
    recoveries.set(run_id=run_id, node_id="n1", resume_operation_id="op-1", existing_world_id=None)
    note, printed = _agents_note(client)
    assert note == (f"Opening or switching projects is held (recovery): {said} has a saved World Labs "
                    "recovery ID; the person forgets it in Run History.")
    assert f"Note: {note}" in printed


def test_f_the_note_for_each_other_state():
    note = project_client.open_hold_note
    assert note({"state": "run"}) == "Opening or switching projects is held (run): a run is going; wait for it to finish, or stop it."
    assert note({"state": "params", "nodeId": "n3", "nodeName": "World", "projectId": "p", "projectName": "Delta",
                 "fields": ["Resume Operation ID"]}, "p") == (
        "Opening or switching projects is held (params): “World” (n3) in the open project “Delta” "
        "has a World Labs ID in its settings (“Resume Operation ID”); the person checks it in Marble and clears it.")
    assert note({"state": "ambiguity", "nodeId": "n2", "nodeName": "World", "projectId": "a", "projectName": "Alpha",
                 "count": 2}, "p") == (
        "Opening or switching projects is held (ambiguity): a World Labs start on “World” (n2) from "
        "“Alpha” needs the person\u2019s check (1 more record after it); they check it in Marble and press "
        "“I’ve checked Marble” in the World Labs notice.")
    assert "restarts the Nebula backend" in note({"state": "bootstrap"})
    assert "paid start is settling" in note({"state": "active"})
    # Agents may relay it to the person: curly apostrophes, as the CLI's other lines (fix12's r16_5).
    for state in ("recovery", "ambiguity", "params", "active", "bootstrap", "run"):
        assert "'" not in note({"state": state, "nodeId": "n1"}), state


def _tool_text(name: str) -> str:
    import mcp_server

    tools = {tool.name: tool for tool in asyncio.run(mcp_server.mcp.list_tools())}
    return " ".join((tools[name].description or "").split())


def test_f_agent_docs_describe_round_22():
    def flat(text: str) -> str:
        return " ".join(text.split())

    listing = _tool_text("list_projects")
    for words in ("`openHold`", "canvas_kept_in_tab", "`sourceName`", "`sourceProjectId`",
                  "Never read the source from the copy's name"):
        assert words in listing, words
    assert "`sourceName`" in _tool_text("get_project") and "`sourceProjectId`" in _tool_text("get_project")
    for name in ("open_project", "new_project"):
        text = _tool_text(name)
        assert "while World Labs state holds" in text and "`hold`" in text, name
    setup = flat((ROOT / "docs/MCP-SETUP.md").read_text())
    skill = flat((ROOT / "skills/nebula/SKILL.md").read_text())
    rows = {line.split("|")[1].strip(): line for line in (ROOT / "docs/MCP-SETUP.md").read_text().splitlines()
            if line.startswith("| `")}
    assert "`projectId`, `runId`" in rows["`node.result`"]
    assert "`proposalsOpen`" in rows["`canvas.replaced`"] and "`renumberedCount`" in rows["`canvas.replaced`"]
    created = rows["`project.created` / `project.deleted` / `project.restored`"]
    assert "`sourceName`" in created and "`sourceProjectId`" in created
    for text in (setup, skill):
        assert "covers Nebula's own holds only" in text and "canvas_kept_in_tab" in text
        assert "from “Alpha” has a saved World Labs recovery ID; the person forgets it in Run History." in text
        assert "with no side effect" not in text and "Reading it changes nothing" not in text
    assert "`paid_bootstrap`" in setup and "nodeLandedAt" in setup
    for name in ("list_projects", "get_project", "open_project", "new_project"):
        assert not {"wire", "wired"} & set(_tool_text(name).lower().split()), name
    assert "with no side effect" not in (main_module._graph_replacement_hold.__doc__ or "")
    assert "with no side effect" not in (main_module.get_open_hold.__doc__ or "")


# -- G. the records' bytes for the tab and agents are unchanged ----------------------------------

def test_g_the_records_reads_carry_the_same_fields_as_before(app, recoveries):
    """The export and graphSync carry providerRecoveries and
    providerStartAmbiguities exactly as on 69277f89 (no project fields), and
    GET /api/graph carries neither, as before."""
    client, *_ = app
    _alpha_then_delta(client)
    recoveries.set(run_id="wl-run-alpha", node_id="n1", resume_operation_id="op-a", existing_world_id=None)
    main_module.provider_start_guard.mark_ambiguous(run_id="wl-run-delta", node_id="n1", kind=ENVIRONMENT)
    want_recoveries = [{"runId": "wl-run-alpha", "nodeId": "n1", "resumeOperationId": "op-a",
                        "existingWorldId": None}]
    exported = client.get("/api/graph/export", headers=PERSON).json()
    graph = client.get("/api/graph", headers=CODEX).json()
    asyncio.run(main_module._broadcast_graph_sync())
    synced = _syncs()[-1]
    assert "providerRecoveries" not in graph and "providerStartAmbiguities" not in graph
    for read in (exported, synced):
        assert json.dumps(read["providerRecoveries"], sort_keys=False) == json.dumps(want_recoveries)
        assert [sorted(record) for record in read["providerStartAmbiguities"]] == [AMBIGUITY_KEYS]
        ambiguity = read["providerStartAmbiguities"][0]
        assert (ambiguity["runId"], ambiguity["nodeId"], ambiguity["kind"]) == ("wl-run-delta", "n1", ENVIRONMENT)


AMBIGUITY_KEYS = sorted(["durable", "kind", "message", "nodeId", "runId"])
