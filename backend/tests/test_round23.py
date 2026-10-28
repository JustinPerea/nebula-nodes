"""Round 23 of PR #195: review 22's M-1 (the backend half) and L-4.

- M-1: a person's note is anchored by a node id of the canvas it was written
  on. Node ids restart at n1 in every project and after a clear, so a note
  sent after an agent opened another project (or cleared this one) must never
  land on that canvas's n1. The pin routes are graph writes for the fence
  (``graph_write``): a canvas tab's POST and DELETE carry the project and
  canvas they were made for and are refused (409) when either moved, with
  nothing pinned and nothing journaled. An agent's ``resolve_pin`` on a note
  that isn't in the open project says so in words an agent can act on.
- L-4: once a run is admitted it has started (and may be spending). A step
  after admission that fails (the placeholder broadcast reading the catalog,
  the skip notes, the cursor) never turns the answer into an error: the run
  answers ``status: "started"`` with its run id, the failure is logged and
  named separately (``canvasSync``), and the broadcast is tried again, so an
  agent never retries a paid run that started.
"""
from __future__ import annotations

import pathlib

import pytest

from services.project_store import ProjectStoreError, make_project
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, CODEX, api  # noqa: F401 - fixture
from tests.test_pending_nodes import _chain, _execute_body, pend  # noqa: F401 - fixture

TAB = {**PERSON, "X-Nebula-Tab": "tab-r23"}
ROOT = pathlib.Path(__file__).resolve().parents[2]


def _journaled(main, monkeypatch) -> list[str]:
    kinds: list[str] = []
    real = main._journal

    def record(kind, **kwargs):
        kinds.append(kind)
        return real(kind, **kwargs)

    monkeypatch.setattr(main, "_journal", record)
    return kinds


def _context(main) -> dict:
    return main._workspace_context()


def _open_second_project(api, name="Beta") -> str:
    main = api.main
    with main.project_store.transaction() as catalog:
        other = make_project(name)
        catalog["projects"][other["id"]] = other
        main.project_store.commit(catalog)
    revision = _context(main)["workspaceRevision"]
    response = api.client.post(f"/api/projects/{other['id']}/open", headers=CODEX, json={"workspaceRevision": revision})
    assert response.status_code == 200, response.text
    return other["id"]


def _tab_headers(revision: str, canvas: str | None = None) -> dict[str, str]:
    headers = {**TAB, "X-Nebula-Workspace-Revision": revision}
    if canvas is not None:
        headers["X-Nebula-Canvas-Revision"] = canvas
    return headers


# ---------------------------------------------------------------------------
# M-1: the pin routes and the fence


def test_M1_every_pin_write_is_a_fenced_graph_write(api):
    main = api.main
    for method, path in [("POST", "/api/canvas/pins"), ("DELETE", "/api/canvas/pins/pin_1"),
                         ("POST", "/api/canvas/pins/pin_1/resolve")]:
        assert main._graph_fence_of(method, path) == main.FENCE_BEFORE_ROUTE, (method, path)


def test_M1_a_note_written_for_A_n1_is_refused_once_an_agent_opened_B(api, monkeypatch):
    """Review 22's pins.out: A's n1 and B's n1 both exist; the tab still
    sends the revision of A, where the note was written."""
    main = api.main
    response = api.client.post("/api/graph/apply", headers=CLAUDE, json={
        "nodes": [{"ref": "+p", "definitionId": "text-input", "params": {"value": "A's prompt"}}]})
    assert response.json()["idMap"] == {"+p": "n1"}
    written_on = _context(main)
    canvas = main._canvas_revision()
    second = _open_second_project(api)
    response = api.client.post("/api/graph/apply", headers=CODEX, json={
        "nodes": [{"ref": "+q", "definitionId": "text-input", "params": {"value": "B's prompt"}}]})
    assert response.json()["idMap"] == {"+q": "n1"}
    kinds = _journaled(main, monkeypatch)
    response = api.client.post("/api/canvas/pins", headers=_tab_headers(written_on["workspaceRevision"], canvas),
                               json={"text": "Make the sky warmer", "nodeId": "n1"})
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == main.CANVAS_OUT_OF_DATE
    listing = main.canvas_pins.list()
    assert listing["projectId"] == second
    assert listing["pins"] == []
    assert "pin.added" not in kinds


def test_M1_a_tab_note_sent_with_no_project_is_refused(api, monkeypatch):
    """Review 22's PIN-F: sent while the tab followed the switch (it holds no
    project then): never anchored to whatever is open."""
    main = api.main
    api.graph.add_node("text-input", {"value": "a"})
    kinds = _journaled(main, monkeypatch)
    response = api.client.post("/api/canvas/pins", headers=TAB, json={"text": "Make the sky warmer", "nodeId": "n1"})
    assert response.status_code == 409, response.text
    assert main.canvas_pins.list()["pins"] == []
    assert "pin.added" not in kinds


def test_M1_a_note_for_a_canvas_cleared_since_is_refused(api, monkeypatch):
    main = api.main
    api.graph.add_node("text-input", {"value": "a"})
    revision = _context(main)["workspaceRevision"]
    canvas = main._canvas_revision()
    response = api.client.delete("/api/graph?force=true", headers=CODEX)
    assert response.status_code == 200, response.text
    api.graph.add_node("text-input", {"value": "the agent's new n1"})
    kinds = _journaled(main, monkeypatch)
    response = api.client.post("/api/canvas/pins", headers=_tab_headers(revision, canvas),
                               json={"text": "Make the sky warmer", "nodeId": "n1"})
    assert response.status_code == 409, response.text
    assert main.canvas_pins.list()["pins"] == []
    assert "pin.added" not in kinds


def test_M1_a_note_for_the_canvas_open_now_lands(api):
    main = api.main
    api.graph.add_node("text-input", {"value": "a"})
    headers = _tab_headers(_context(main)["workspaceRevision"], main._canvas_revision())
    response = api.client.post("/api/canvas/pins", headers=headers, json={"text": "Make the sky warmer", "nodeId": "n1"})
    assert response.status_code == 201, response.text
    pin_id = response.json()["pin"]["id"]
    response = api.client.delete(f"/api/canvas/pins/{pin_id}", headers=headers)
    assert response.status_code == 200, response.text


def test_M1_a_delete_made_for_another_project_is_refused_not_sent_on(api, monkeypatch):
    main = api.main
    api.graph.add_node("text-input", {"value": "a"})
    headers = _tab_headers(_context(main)["workspaceRevision"], main._canvas_revision())
    pin_id = api.client.post("/api/canvas/pins", headers=headers, json={"text": "warmer", "nodeId": "n1"}).json()["pin"]["id"]
    _open_second_project(api)
    kinds = _journaled(main, monkeypatch)
    response = api.client.delete(f"/api/canvas/pins/{pin_id}", headers=headers)
    assert response.status_code == 409, response.text
    assert "pin.removed" not in kinds


def test_M1_resolve_of_a_note_not_in_the_open_project_says_so_for_agents(api):
    main = api.main
    api.graph.add_node("text-input", {"value": "a"})
    headers = _tab_headers(_context(main)["workspaceRevision"], main._canvas_revision())
    pin_id = api.client.post("/api/canvas/pins", headers=headers, json={"text": "warmer", "nodeId": "n1"}).json()["pin"]["id"]
    _open_second_project(api)
    response = api.client.post(f"/api/canvas/pins/{pin_id}/resolve", headers=CLAUDE, json={"reply": "Warmed it"})
    assert response.status_code == 404, response.text
    detail = response.json()["detail"]
    assert "open project" in detail
    assert "look_at_canvas" in detail


# ---------------------------------------------------------------------------
# L-4: after admission, the run has started


def _run(pend, route, target):
    if route == "cli":
        return pend.client.post("/api/graph/run", headers=CLAUDE, json={"targetNodeId": target})
    body = {**_execute_body(pend), "runId": f"run-{route}"}
    if route == "execute":
        return pend.client.post("/api/execute", headers=CLAUDE, json=body)
    return pend.client.post("/api/execute-node", headers=CLAUDE, json={**body, "targetNodeId": target})


def _broadcast_fails_after_admission(main, monkeypatch) -> dict:
    """Review 22's admission-first-read: the first catalog read after the
    run is admitted fails (the placeholder broadcast's export)."""
    state = {"armed": False, "failed": 0}
    real_admit = main._admit_registered_run
    real_context = main._workspace_context

    def admit(*args, **kwargs):
        result = real_admit(*args, **kwargs)
        state["armed"] = True
        return result

    def context(*args, **kwargs):
        if state["armed"]:
            state["armed"] = False
            state["failed"] += 1
            raise ProjectStoreError("the catalog can't be read")
        return real_context(*args, **kwargs)

    monkeypatch.setattr(main, "_admit_registered_run", admit)
    monkeypatch.setattr(main, "_workspace_context", context)
    return state


@pytest.mark.parametrize("route", ["cli", "execute", "execute-node"])
def test_L4_a_failed_placeholder_broadcast_after_admission_still_answers_started(pend, monkeypatch, route, capsys):
    ids = _chain(pend)
    state = _broadcast_fails_after_admission(pend.main, monkeypatch)
    response = _run(pend, route, ids["+b"])
    assert state["failed"] == 1
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["runId"]
    assert body.get("status") in {"started", "running", "completed", "succeeded", "done"} or route == "cli"
    if route != "cli":
        assert body["status"] == "started"
    assert body["canvasSync"] == "deferred"
    assert "started" in body["canvasSyncDetail"] and "again" in body["canvasSyncDetail"]
    assert pend.ran and pend.ran[0] == sorted(ids.values())
    assert "couldn't tell open canvases" in capsys.readouterr().err


def test_L4_the_cli_run_answers_started_when_a_later_step_fails(pend, monkeypatch):
    """Every step after admission in /api/graph/run: the skip notes, the
    Agent log line, the cursor. None of them says the run didn't start."""
    ids = _chain(pend, pending=False)
    main = pend.main

    async def failing(*args, **kwargs):
        raise ProjectStoreError("the catalog can't be read")

    monkeypatch.setattr(main, "_show_agent", failing)
    monkeypatch.setattr(main, "_say_agent_action", failing)
    monkeypatch.setattr(main, "_announce_skips", failing)
    response = pend.client.post("/api/graph/run", headers=CLAUDE, json={"targetNodeId": ids["+b"]})
    assert response.status_code == 200, response.text
    assert response.json()["runId"]
    assert pend.ran


def test_L4_a_deferred_broadcast_is_owed_and_sent_again(pend, monkeypatch):
    """The canvas still shows the placeholders until a sync says otherwise:
    the broadcast is owed, retried in the background (_pay_owed_graph_sync),
    and any later sync pays it (it carries the whole graph)."""
    import asyncio

    ids = _chain(pend)
    main = pend.main
    _broadcast_fails_after_admission(main, monkeypatch)
    response = _run(pend, "execute", ids["+b"])
    assert response.json()["canvasSync"] == "deferred"
    assert main._graph_sync_owed is True
    sent_before = len([m for m in pend.sent if m.get("type") == "graphSync"])
    assert asyncio.run(main._pay_owed_graph_sync()) is True
    assert len([m for m in pend.sent if m.get("type") == "graphSync"]) == sent_before + 1
    assert main._graph_sync_owed is False
    # Nothing owed: nothing sent.
    assert asyncio.run(main._pay_owed_graph_sync()) is True
    assert len([m for m in pend.sent if m.get("type") == "graphSync"]) == sent_before + 1


def test_L4_any_later_sync_pays_what_is_owed(pend, monkeypatch):
    import asyncio

    main = pend.main
    monkeypatch.setattr(main, "_graph_sync_owed", True)
    asyncio.run(main._broadcast_graph_sync())
    assert main._graph_sync_owed is False


def test_L4_every_run_route_broadcasts_after_admission_best_effort():
    """The four routes that admit a run (execute, execute-node, the shot,
    /api/graph/run) never await a bare _broadcast_graph_sync after it."""
    source = (ROOT / "backend" / "main.py").read_text()
    for marker in ("_admit_registered_run(run_id, ready, nodes, edges, run_canvas)",
                   "_admit_registered_run(run_id, ready, sub_nodes, sub_edges, run_canvas)\n    except ExecutionCancelledBeforeStartError as exc:\n        await asyncio.gather(task",
                   "placeholders_changed = bool(_clear_pending(ready))",
                   "_admit_registered_run(run_id, ready, sub_nodes, sub_edges, run_canvas)\n    except BaseException"):
        at = source.index(marker)
        tail = source[at:source.index("\n\n\n", at)]
        assert "await _broadcast_graph_sync()" not in tail.split("if placeholders_changed", 1)[-1][:200], marker
        assert "_broadcast_admitted_run(run_id, placeholders_changed)" in tail, marker


# ---------------------------------------------------------------------------
# Agents read both


def test_docs_and_instructions_name_the_pin_fence_and_the_started_answer():
    setup = (ROOT / "docs" / "MCP-SETUP.md").read_text()
    skill = (ROOT / "skills" / "nebula" / "SKILL.md").read_text()
    mcp = (ROOT / "backend" / "mcp_server.py").read_text()
    for text in (setup, skill):
        assert "canvasSync" in text
        assert "isn't in the open project" in text
    assert "canvasSync" in mcp
    assert "not in the open project" in mcp or "isn't in the open project" in mcp
