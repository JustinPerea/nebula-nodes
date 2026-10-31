"""Round 14 of PR #114: the canvas-replacement paid guard.

1. Review 13, nit 7: `_reject_graph_replacement_during_paid_start` reads the
   ambiguity list once, so its rule is literally the pre-round-13 one. Before,
   an ambiguity acknowledged between two reads while a recovery record existed
   let the replacement through (the reviewer's probe F); b2b1529e refused it.
2. The bootstrap retry path (coordinator's round 14 decisions, Justin's
   "complete fixes" rule): `_graph_recovery_bootstrap_error` (Nebula couldn't
   journal a recovery it read from the canvas at boot) refused a graph bundle
   restore, and retrying never cleared it. The restore now re-runs the
   re-seed a run start does, under the lifecycle fence, first. A journal that
   takes it clears the error and the restore goes on; one that still can't be
   written refuses as before, with the person's general line and, for agents,
   a detail that says the retry was made and a backend restart is needed.
Which states refuse is otherwise unchanged.
"""
from __future__ import annotations

import io
import json
import os
import stat
import zipfile

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from tests.conftest import PERSON

AGENT = {"X-Nebula-Agent": "Claude Code"}
# GM, round 15 of PR #114 (item 5): under the screen's own "Couldn't <action>." heading.
BOOTSTRAP_PERSON = "Nebula couldn't save its World Labs safeguards. Restart Nebula, then try again."
GENERAL_LINE = BOOTSTRAP_PERSON  # the name the round 14 probes import
FENCE_UNVERIFIABLE = (
    "Cannot restore a graph bundle because Nebula cannot verify the durable World Labs paid-start fence."
)
BOOTSTRAP_AGENT_DETAIL = (
    "Cannot restore a graph bundle: Nebula retried saving its World Labs recovery journal and "
    "couldn't write it. Restart the Nebula backend, then try again."
)


@pytest.fixture
def canvas(tmp_path, monkeypatch, person):
    import main as main_module
    from services.agent_presence import AgentPresence
    from services.canvas_events import CanvasEventJournal
    from services.canvas_pins import CanvasPins
    from services.canvas_proposals import ProposalBook
    from services.cli_graph import CLIGraph
    from services.project_store import ProjectStore, make_project
    from services.provider_start_guard import ProviderStartGuard

    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Active")
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)
    output_root = tmp_path / "output"
    output_root.mkdir()

    async def capture(_data):
        return None

    monkeypatch.setattr(main_module, "OUTPUT_ROOT", output_root)
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "canvas_proposals", ProposalBook())
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "canvas_events", CanvasEventJournal())
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", capture)

    class Ctx:
        pass

    ctx = Ctx()
    ctx.main = main_module
    ctx.client = TestClient(main_module.app)
    ctx.graph = graph
    ctx.tmp = tmp_path
    ctx.output_root = output_root
    return ctx


def _use_recovery_store(canvas, monkeypatch, directory):
    from services.provider_recovery import ProviderRecoveryStore

    directory.mkdir(exist_ok=True)
    store = ProviderRecoveryStore(directory / "provider-recoveries.json")
    monkeypatch.setattr(canvas.main, "provider_recovery_store", store)
    return store


@pytest.fixture
def unwritable(tmp_path):
    """A journal folder Nebula can't write (its lock file can't be made)."""
    directory = tmp_path / "unwritable-state"
    directory.mkdir()
    yield directory
    os.chmod(directory, stat.S_IRWXU)


def _bundle() -> bytes:
    graph = {"version": 3, "paramsVersion": 1, "name": "Glass", "createdAt": "2026-10-27T00:00:00.000Z",
             "nodes": [{"id": "a", "type": "model-node", "position": {"x": 0, "y": 0},
                        "data": {"label": "Note", "definitionId": "text-input",
                                 "params": {"value": "a lighthouse"}, "outputs": {}}}],
             "edges": []}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("graph.json", json.dumps(graph))
        archive.writestr("assets/old/pic.png", b"\x89PNG\r\n\x1a\nPIC")
    return buffer.getvalue()


def _restore(canvas, headers):
    return canvas.client.post("/api/outputs/restore", content=_bundle(),
                              headers={**headers, "content-type": "application/zip"})


# -- 1. nit 7: one read of the ambiguity list ---------------------------------------------

def test_an_ambiguity_that_goes_between_reads_still_refuses_while_a_record_exists(canvas, monkeypatch):
    """Review 13's probe F: b2b1529e refused (409); round 13 let it through."""
    main = canvas.main
    reads = iter([[{"kind": "worldlabs-environment", "nodeId": "n9", "runId": "r9"}], []])
    monkeypatch.setattr(main.provider_start_guard, "has_active", lambda: False)
    monkeypatch.setattr(main.provider_start_guard, "list", lambda: next(reads, []))
    monkeypatch.setattr(main.provider_recovery_store, "list",
                        lambda: [{"runId": "r", "nodeId": "n1", "resumeOperationId": "op"}])
    with pytest.raises(HTTPException) as refused:
        main._reject_graph_replacement_during_paid_start("restore a graph bundle")
    assert refused.value.status_code == 409


# -- 2. the bootstrap retry -------------------------------------------------------------

def test_a_restore_retries_the_bootstrap_and_goes_on_when_the_journal_takes_it(canvas, monkeypatch):
    """Round 15 (review 14, M4): the retry makes a real journal write, so the
    journal file exists after it although the canvas holds no IDs to seed."""
    store = _use_recovery_store(canvas, monkeypatch, canvas.tmp / "state")
    journal = canvas.tmp / "state" / "provider-recoveries.json"
    assert not journal.exists()
    monkeypatch.setattr(canvas.main, "_graph_recovery_bootstrap_error", "journal unavailable")
    response = _restore(canvas, AGENT)
    assert response.status_code == 200, response.text
    assert canvas.main._graph_recovery_bootstrap_error is None
    assert journal.is_file() and json.loads(journal.read_text())["records"] == []
    assert store.is_healthy()
    # A second restore isn't held up either.
    assert _restore(canvas, PERSON).status_code == 200


def test_the_retry_reseeds_under_the_lifecycle_fence(canvas, monkeypatch):
    """The same safeguard re-seed a run start does, under the lock a canvas
    replacement takes (exclusive_lifecycle)."""
    _use_recovery_store(canvas, monkeypatch, canvas.tmp / "state")
    monkeypatch.setattr(canvas.main, "_graph_recovery_bootstrap_error", "journal unavailable")
    guard = canvas.main.provider_start_guard
    real = guard.exclusive_lifecycle
    calls: list[tuple[str, bool]] = []
    fenced = {"in": False}

    from contextlib import contextmanager

    @contextmanager
    def watched():
        with real():
            fenced["in"] = True
            try:
                yield
            finally:
                fenced["in"] = False

    seed = canvas.main._ensure_shared_graph_recoveries

    def watched_seed(nodes, *, source):
        calls.append((source, fenced["in"]))
        return seed(nodes, source=source)

    monkeypatch.setattr(guard, "exclusive_lifecycle", watched)
    monkeypatch.setattr(canvas.main, "_ensure_shared_graph_recoveries", watched_seed)
    canvas.main._reject_graph_replacement_during_paid_start("restore a graph bundle")
    assert calls == [("bootstrap-retry", True)]
    assert canvas.main._graph_recovery_bootstrap_error is None


@pytest.mark.unprivileged
def test_a_retry_that_still_cant_write_the_journal_refuses_and_keeps_the_error(canvas, monkeypatch, unwritable):
    """As at boot: the seed of the canvas's IDs couldn't be written (the
    journal's folder is read-only), so the store is unhealthy and the error
    is set; the IDs have since left the canvas, so the bootstrap state is
    what holds it."""
    from services.provider_recovery import ProviderRecoveryPersistenceError

    store = _use_recovery_store(canvas, monkeypatch, unwritable)
    os.chmod(unwritable, stat.S_IRUSR | stat.S_IXUSR)
    with pytest.raises(ProviderRecoveryPersistenceError) as boot:
        store.ensure_many(run_id="graph-bootstrap-test", checkpoints=[("world-node", "accepted-operation", None)])
    monkeypatch.setattr(canvas.main, "_graph_recovery_bootstrap_error", str(boot.value))
    node = canvas.graph.add_node("text-input", {"value": "kept"}, position={"x": 0, "y": 0})
    before = json.dumps([canvas.graph.nodes, canvas.graph.edges], sort_keys=True, default=str)

    person = _restore(canvas, PERSON)
    assert person.status_code == 409
    assert person.json()["detail"] == BOOTSTRAP_PERSON
    agent = _restore(canvas, AGENT)
    assert agent.status_code == 409
    assert agent.json()["detail"] == BOOTSTRAP_AGENT_DETAIL

    assert canvas.main._graph_recovery_bootstrap_error is not None
    after = json.dumps([canvas.graph.nodes, canvas.graph.edges], sort_keys=True, default=str)
    assert after == before and list(canvas.graph.nodes) == [node]
    assert list(canvas.output_root.iterdir()) == []


def test_a_journal_that_raises_on_the_reseed_refuses_with_the_same_lines(canvas, monkeypatch):
    """The other way the re-seed fails: the store raises
    ProviderRecoveryPersistenceError (a canvas whose IDs it must journal)."""
    from services.provider_recovery import ProviderRecoveryPersistenceError

    _use_recovery_store(canvas, monkeypatch, canvas.tmp / "state")
    monkeypatch.setattr(canvas.main, "_graph_recovery_bootstrap_error", "journal unavailable")

    def fail(_nodes, *, source):
        raise ProviderRecoveryPersistenceError("provider recovery journal write failed")

    monkeypatch.setattr(canvas.main, "_ensure_shared_graph_recoveries", fail)
    assert _restore(canvas, PERSON).json()["detail"] == BOOTSTRAP_PERSON
    agent = _restore(canvas, AGENT)
    assert agent.status_code == 409 and agent.json()["detail"] == BOOTSTRAP_AGENT_DETAIL
    assert canvas.main._graph_recovery_bootstrap_error is not None


def test_other_states_still_win_over_the_bootstrap_error_and_never_retry(canvas, monkeypatch):
    """Which states refuse is unchanged: an ambiguity, a record or an ID in
    the params still refuse first, with their own lines, and no re-seed runs."""
    main = canvas.main
    _use_recovery_store(canvas, monkeypatch, canvas.tmp / "state")
    monkeypatch.setattr(main, "_graph_recovery_bootstrap_error", "journal unavailable")
    monkeypatch.setattr(main, "_ensure_shared_graph_recoveries",
                        lambda *_a, **_k: pytest.fail("the bootstrap retry ran for another state"))
    monkeypatch.setattr(main.provider_start_guard, "list",
                        lambda: [{"kind": "worldlabs-environment", "nodeId": "n9", "runId": "r9"}])
    response = _restore(canvas, AGENT)
    assert response.status_code == 409
    assert response.json()["detail"] != BOOTSTRAP_AGENT_DETAIL
    assert main._graph_recovery_bootstrap_error == "journal unavailable"


# -- 3. agents: the MCP tool that restores a bundle passes the detail on unchanged -----------

@pytest.mark.unprivileged
def test_load_graph_file_hands_the_agent_the_bootstrap_detail(canvas, monkeypatch, unwritable):
    import asyncio

    import mcp_server
    from mcp.server.fastmcp.exceptions import ToolError
    from nebula_api import NebulaAPI
    from services.provider_recovery import ProviderRecoveryPersistenceError

    store = _use_recovery_store(canvas, monkeypatch, unwritable)
    os.chmod(unwritable, stat.S_IRUSR | stat.S_IXUSR)
    with pytest.raises(ProviderRecoveryPersistenceError) as boot:
        store.ensure_many(run_id="graph-bootstrap-test", checkpoints=[("world-node", "accepted-operation", None)])
    monkeypatch.setattr(canvas.main, "_graph_recovery_bootstrap_error", str(boot.value))
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=canvas.client))
    bundle = canvas.tmp / "glass.nebula.zip"
    bundle.write_bytes(_bundle())
    with pytest.raises(ToolError) as refused:
        asyncio.run(mcp_server.mcp.call_tool("load_graph_file", {"path": str(bundle)}))
    assert str(refused.value) == f"Error executing tool load_graph_file: {bundle}: {BOOTSTRAP_AGENT_DETAIL}"
    assert "read-only" not in str(refused.value)


# -- 4. round 15 (review 14, M4 + L7): the retry proves the journal takes a real write -------

def _boot_failure(canvas, monkeypatch, directory):
    """A real boot failure: the journal's folder is read-only, so the seed of
    the canvas's IDs raises and the store goes unhealthy."""
    from services.provider_recovery import ProviderRecoveryPersistenceError

    store = _use_recovery_store(canvas, monkeypatch, directory)
    os.chmod(directory, stat.S_IRUSR | stat.S_IXUSR)
    with pytest.raises(ProviderRecoveryPersistenceError) as boot:
        store.ensure_many(run_id="graph-bootstrap-test", checkpoints=[("world-node", "accepted-operation", None)])
    monkeypatch.setattr(canvas.main, "_graph_recovery_bootstrap_error", str(boot.value))
    return store


@pytest.mark.unprivileged
def test_b1_a_journal_fixed_after_a_real_boot_failure_lets_the_restore_go_on(canvas, monkeypatch, unwritable):
    """Review 14's B1: once the folder can be written again, the next restore's
    retry writes the journal, clears the error and goes on."""
    store = _boot_failure(canvas, monkeypatch, unwritable)
    assert _restore(canvas, AGENT).status_code == 409
    os.chmod(unwritable, stat.S_IRWXU)  # the person fixes the folder
    response = _restore(canvas, AGENT)
    assert response.status_code == 200, response.text
    assert canvas.main._graph_recovery_bootstrap_error is None
    assert store.is_healthy()
    assert (unwritable / "provider-recoveries.json").is_file()


@pytest.mark.unprivileged
def test_b4_a_healthy_flag_over_an_unwritable_journal_still_refuses(canvas, monkeypatch, unwritable):
    """Review 14's B4: the store's last operation succeeded (its flag says
    healthy), then the folder went read-only. The canvas holds no IDs, so the
    re-seed writes nothing; the retry's own write fails, so it refuses and the
    error stays."""
    store = _use_recovery_store(canvas, monkeypatch, unwritable)
    store.list()  # healthy, and the lock file exists
    os.chmod(unwritable, stat.S_IRUSR | stat.S_IXUSR)
    monkeypatch.setattr(canvas.main, "_graph_recovery_bootstrap_error", "journal unavailable")
    before = json.dumps([canvas.graph.nodes, canvas.graph.edges], sort_keys=True, default=str)
    agent = _restore(canvas, AGENT)
    assert agent.status_code == 409 and agent.json()["detail"] == BOOTSTRAP_AGENT_DETAIL
    person = _restore(canvas, PERSON)
    assert person.status_code == 409 and person.json()["detail"] == BOOTSTRAP_PERSON
    assert canvas.main._graph_recovery_bootstrap_error is not None
    assert not store.is_healthy()
    assert json.dumps([canvas.graph.nodes, canvas.graph.edges], sort_keys=True, default=str) == before


def test_l7_an_unhealthy_paid_start_store_answers_its_own_507_and_keeps_the_bootstrap_error(canvas, monkeypatch):
    """Review 14's L7: the retry can't take the paid-start fence because that
    store is unhealthy. It answers what a canvas replacement answers for it
    (507), blames that store, and leaves the bootstrap error as it was."""
    _use_recovery_store(canvas, monkeypatch, canvas.tmp / "state")
    monkeypatch.setattr(canvas.main, "_graph_recovery_bootstrap_error", "journal unavailable")
    monkeypatch.setattr(canvas.main.provider_start_guard, "_storage_error", "provider-starts.json is invalid")
    before = json.dumps([canvas.graph.nodes, canvas.graph.edges], sort_keys=True, default=str)
    response = _restore(canvas, AGENT)
    assert response.status_code == 507
    assert response.json()["detail"] == FENCE_UNVERIFIABLE
    assert canvas.main._graph_recovery_bootstrap_error == "journal unavailable"
    assert json.dumps([canvas.graph.nodes, canvas.graph.edges], sort_keys=True, default=str) == before


@pytest.mark.unprivileged
def test_verify_writable_is_a_real_write_and_read_back(tmp_path):
    from services.provider_recovery import ProviderRecoveryPersistenceError, ProviderRecoveryStore

    directory = tmp_path / "journal"
    directory.mkdir()
    store = ProviderRecoveryStore(directory / "provider-recoveries.json")
    store.set(run_id="r1", node_id="n1", resume_operation_id="op-1", existing_world_id=None)
    store.verify_writable()
    payload = json.loads((directory / "provider-recoveries.json").read_text())
    assert [record["nodeId"] for record in payload["records"]] == ["n1"]
    # Another reader still loads it (the probe mark is ignored).
    assert [record["nodeId"] for record in ProviderRecoveryStore(directory / "provider-recoveries.json").list()] == ["n1"]
    os.chmod(directory, stat.S_IRUSR | stat.S_IXUSR)
    try:
        assert store.is_healthy()
        with pytest.raises(ProviderRecoveryPersistenceError):
            store.verify_writable()
        assert not store.is_healthy()
    finally:
        os.chmod(directory, stat.S_IRWXU)
    # Fixed: the next probe succeeds and clears the flag; the records are intact.
    store.verify_writable()
    assert store.is_healthy()
    assert [record["nodeId"] for record in store.list()] == ["n1"]


# -- 5. every other place that clears the bootstrap error needs the same real write ----------

def _make_node(canvas, headers=PERSON):
    """An ordinary edit that takes the paid-start fence: a param change
    (`_paid_graph_mutation("update graph node parameters")`)."""
    node = canvas.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    return canvas.client.put(f"/api/graph/node/{node}", headers=headers, json={"params": {"value": "b"}})


def test_an_ordinary_edit_clears_the_bootstrap_error_only_after_a_real_write(canvas, monkeypatch):
    """`_paid_graph_mutation`'s preflight cleared the error after a seed that
    wrote nothing (no IDs on the canvas). It now proves the journal first."""
    _use_recovery_store(canvas, monkeypatch, canvas.tmp / "state")
    journal = canvas.tmp / "state" / "provider-recoveries.json"
    monkeypatch.setattr(canvas.main, "_graph_recovery_bootstrap_error", "journal unavailable")
    made = _make_node(canvas)
    assert made.status_code == 200, made.text
    assert canvas.main._graph_recovery_bootstrap_error is None
    assert journal.is_file()


@pytest.mark.unprivileged
def test_an_ordinary_edit_over_an_unwritable_journal_goes_on_and_keeps_the_error(canvas, monkeypatch, unwritable):
    """Which states refuse is unchanged: a node add isn't refused for the
    bootstrap state, but it no longer clears it either."""
    store = _use_recovery_store(canvas, monkeypatch, unwritable)
    store.list()
    os.chmod(unwritable, stat.S_IRUSR | stat.S_IXUSR)
    monkeypatch.setattr(canvas.main, "_graph_recovery_bootstrap_error", "journal unavailable")
    made = _make_node(canvas)
    assert made.status_code == 200, made.text
    assert canvas.main._graph_recovery_bootstrap_error is not None
    assert _restore(canvas, AGENT).json()["detail"] == BOOTSTRAP_AGENT_DETAIL


def test_an_ordinary_edit_without_the_error_makes_no_extra_journal_write(canvas, monkeypatch):
    store = _use_recovery_store(canvas, monkeypatch, canvas.tmp / "state")
    monkeypatch.setattr(store, "verify_writable", lambda: pytest.fail("verified with no bootstrap error"))
    assert _make_node(canvas).status_code == 200


def _world():
    from models import GraphNode

    return GraphNode(id="world-node", definitionId="worldlabs-environment", params={}, outputs={})


def test_a_paid_start_clears_the_bootstrap_error_only_after_a_real_write(canvas, monkeypatch):
    _use_recovery_store(canvas, monkeypatch, canvas.tmp / "state")
    journal = canvas.tmp / "state" / "provider-recoveries.json"
    monkeypatch.setattr(canvas.main, "_graph_recovery_bootstrap_error", "journal unavailable")
    canvas.main._claim_fresh_paid_worldlabs_starts(run_id="fresh-run", nodes=[_world()])
    try:
        assert canvas.main._graph_recovery_bootstrap_error is None
        assert journal.is_file()
    finally:
        canvas.main.provider_start_guard.release_run("fresh-run")


@pytest.mark.unprivileged
def test_a_paid_start_over_an_unwritable_journal_is_refused_and_keeps_the_error(canvas, monkeypatch, unwritable):
    store = _use_recovery_store(canvas, monkeypatch, unwritable)
    store.list()
    os.chmod(unwritable, stat.S_IRUSR | stat.S_IXUSR)
    monkeypatch.setattr(canvas.main, "_graph_recovery_bootstrap_error", "journal unavailable")
    with pytest.raises(HTTPException) as refused:
        canvas.main._claim_fresh_paid_worldlabs_starts(run_id="fresh-run", nodes=[_world()])
    assert refused.value.status_code == 507
    assert canvas.main._graph_recovery_bootstrap_error is not None
    assert canvas.main.provider_start_guard.has_active() is False


# -- 6. round 15 (review 14, nit 3): the socket says which backend process it is ------------

def test_the_first_ws_message_carries_this_processes_boot_id(canvas):
    """A tab releases a create whose answer was lost only after a backend
    restart (a new bootId), not on a mere socket reconnect."""
    seen = []
    for _ in range(2):
        with canvas.client.websocket_connect("/ws") as socket:
            first = json.loads(socket.receive_text())
        assert first["type"] == "graphSync"
        assert isinstance(first.get("bootId"), str) and first["bootId"]
        # PR #198 fix round 12 (review 11, L-4): and when it started, so a tab
        # orders processes whatever order their messages arrive in.
        assert first.get("bootStartedAt") == canvas.main.BACKEND_BOOT_STARTED_AT
        seen.append(first["bootId"])
    assert seen[0] == seen[1] == canvas.main.BACKEND_BOOT_ID
