"""Round 22 of PR #195: review 21 L-e and GM's round-22 Accept wording.

- L-e: once a run is registered, nothing reads storage (``_register_run``'s
  own rule). ``_admit_registered_run`` used to make the placeholders normal
  (saved) and only then read the workspace again for the agent-run record,
  so a failing read answered "nothing started" (507) with the placeholders
  already changed. The reads now come before the one write, and the project
  is the one the run registered on.
- GM round 22 (4b): an Accept refused because the canvas was cleared or
  replaced after the proposal was made carries ``code:
  "proposal_canvas_replaced"`` (the canvas reads the code, never the words)
  and a detail that says the same as the person's line.
"""
from __future__ import annotations

import pytest

from services.project_store import ProjectStoreError
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, KEY, _key, _propose, api  # noqa: F401 - fixture
from tests.test_pending_nodes import CLAUDE_ID, _chain, _execute_body, _owner, _synced_pending, pend  # noqa: F401


def _run(pend, route, target):
    if route == "cli":
        return pend.client.post("/api/graph/run", headers=CLAUDE, json={"targetNodeId": target})
    body = {**_execute_body(pend), "runId": f"run-{route}"}
    if route == "execute":
        return pend.client.post("/api/execute", headers=CLAUDE, json=body)
    return pend.client.post("/api/execute-node", headers=CLAUDE, json={**body, "targetNodeId": target})


def _storage_fails_once_registered(main, monkeypatch):
    """The catalog can't be read from the moment the run is registered until
    its admission returns (review 21's ADMFAIL, as the real read fails)."""
    armed = {"on": False}
    real_context = main._workspace_context

    def context(*args, **kwargs):
        if armed["on"]:
            raise ProjectStoreError("the catalog can't be read")
        return real_context(*args, **kwargs)

    real_register = main._register_run

    def register(*args, **kwargs):
        record = real_register(*args, **kwargs)
        armed["on"] = True
        return record

    real_admit = main._admit_registered_run

    def admit(*args, **kwargs):
        try:
            return real_admit(*args, **kwargs)
        finally:
            armed["on"] = False

    monkeypatch.setattr(main, "_workspace_context", context)
    monkeypatch.setattr(main, "_register_run", register)
    monkeypatch.setattr(main, "_admit_registered_run", admit)


@pytest.mark.parametrize("route", ["cli", "execute", "execute-node"])
def test_Le_admission_reads_no_storage_once_the_run_is_registered(pend, monkeypatch, route):
    ids = _chain(pend)
    kept = []
    real_start = pend.main.agent_runs.start

    def start(run_id, identity, **kwargs):
        kept.append((run_id, identity.name, kwargs["project_id"]))
        return real_start(run_id, identity, **kwargs)

    monkeypatch.setattr(pend.main.agent_runs, "start", start)
    project_id = pend.main._workspace_context()["activeProjectId"]
    _storage_fails_once_registered(pend.main, monkeypatch)
    response = _run(pend, route, ids["+b"])
    # Nothing between registration and the end of admission reads the
    # catalog: the run is admitted as usual.
    assert response.status_code == 200, response.text
    # The agent's run is kept, on the project it registered on.
    assert [(name, project) for _run_id, name, project in kept] == [("Claude Code", project_id)]


@pytest.mark.parametrize("route", ["cli", "execute", "execute-node"])
def test_Le_a_failing_read_in_admission_changes_nothing(pend, monkeypatch, route):
    """The identity or plan read failing: refused, and the placeholders are
    still placeholders (never saved as normal first)."""
    ids = _chain(pend)

    def failing(*args, **kwargs):
        raise ProjectStoreError("the catalog can't be read")

    monkeypatch.setattr(pend.main, "_agent_run_plan", failing)
    response = _run(pend, route, ids["+b"])
    assert response.status_code == 507, response.text
    assert pend.ran == []
    assert all(_owner(pend, node_id)["id"] == CLAUDE_ID for node_id in ids.values())
    assert pend.main.agent_runs._runs == {}


@pytest.mark.parametrize("route", ["cli", "execute", "execute-node"])
def test_Le_a_failing_placeholder_save_keeps_no_agent_run(pend, monkeypatch, route):
    """The one write (the placeholders made normal, saved) failing: nothing
    was kept for the run either."""
    ids = _chain(pend)

    def failing(*args, **kwargs):
        raise ProjectStoreError("the graph can't be saved")

    monkeypatch.setattr(pend.main, "_clear_pending", failing)
    response = _run(pend, route, ids["+b"])
    assert response.status_code == 507, response.text
    assert pend.ran == []
    assert all(_owner(pend, node_id)["id"] == CLAUDE_ID for node_id in ids.values())
    assert pend.main.agent_runs._runs == {}


# ---------------------------------------------------------------------------
# GM round 22 (4b): Accept after the canvas was cleared or replaced


def test_accept_after_the_canvas_moved_carries_the_code_and_the_detail(api):
    api.graph.add_node("text-input", {"value": "a cat"})
    body = {"note": "Add a prompt", "nodes": [{"ref": "+t", "definitionId": "text-input"}], "edges": []}
    proposed = _propose(api, body)
    assert proposed.status_code == 201, proposed.text
    proposal_id = proposed.json()["proposal"]["id"]
    key = _key(api, proposal_id)
    # A clear or an import landed inside the accept's own await (review 20, L-3).
    api.main.canvas_undo_book.advance_epoch(api.main._workspace_context()["activeProjectId"])
    response = api.client.post(f"/api/canvas/proposals/{proposal_id}/accept", headers={**PERSON, KEY: key}, json={})
    assert response.status_code == 409, response.text
    answer = response.json()
    assert answer["code"] == "proposal_canvas_replaced"
    assert answer["detail"] == api.main.PROPOSAL_CANVAS_REPLACED_DETAIL
    assert answer["detail"] == (
        "Couldn't accept this proposal: the canvas was cleared or replaced after it was made. "
        "Make a new proposal for the canvas as it is now.")


def test_the_mcp_instructions_and_docs_say_the_new_accept_refusal(api):
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[2]
    setup = (root / "docs" / "MCP-SETUP.md").read_text()
    skill = (root / "skills" / "nebula" / "SKILL.md").read_text()
    assert "proposal_canvas_replaced" in setup
    assert "cleared or replaced after it was made" in skill
