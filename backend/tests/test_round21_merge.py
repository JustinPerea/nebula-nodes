"""Round 21 of PR #195: the merge of main (PR #114, c1e7338c).

- Run admission (review 20, C3): a run refused at the last fence (the canvas
  moved while it awaited) leaves the placeholders it would have made normal
  as they were, and keeps no agent-run record.
- The canvas check (C2): with a filed revision the canvas header is compared
  with the filed canvas's epoch; otherwise with the live one.
- The epoch base: canvas revisions that can't be restored after a restart
  (the file unreadable, missing while a canvas was saved before, or memory
  only) start from a boot-unique base, never from 0, and the sync says
  ``canvasRevisionRestored: false``.
"""
from __future__ import annotations

import json

import pytest

from services import pending_nodes
from services.canvas_undo import CanvasUndoBook
from tests.test_canvas_proposals import CLAUDE, api  # noqa: F401 - fixture
from tests.test_pending_nodes import CLAUDE_ID, _chain, _execute_body, _owner, _synced_pending, pend  # noqa: F401


# ---------------------------------------------------------------------------
# C3: a run refused at the last fence changes nothing


def _move_canvas_during_the_spend_check(pend, monkeypatch):
    """The spend check is the last await before the final fence: the canvas
    moving there (an agent's clear lands) makes the final fence refuse."""
    main = pend.main

    def moved(*args, **kwargs):
        main.canvas_undo_book.advance_epoch(main._workspace_context()["activeProjectId"])

    monkeypatch.setattr(main, "_require_spend_approval", moved)


def _run(pend, route, target):
    if route == "cli":
        return pend.client.post("/api/graph/run", headers=CLAUDE, json={"targetNodeId": target})
    body = {**_execute_body(pend), "runId": f"run-{route}"}
    if route == "execute":
        return pend.client.post("/api/execute", headers=CLAUDE, json=body)
    return pend.client.post("/api/execute-node", headers=CLAUDE, json={**body, "targetNodeId": target})


@pytest.mark.parametrize("route", ["cli", "execute", "execute-node"])
def test_a_run_refused_at_the_last_fence_leaves_placeholders_and_keeps_no_agent_run(pend, monkeypatch, route):
    ids = _chain(pend)
    _move_canvas_during_the_spend_check(pend, monkeypatch)
    response = _run(pend, route, ids["+b"])
    assert response.status_code == 409, response.text
    assert pend.ran == []
    assert all(_owner(pend, node_id)["id"] == CLAUDE_ID for node_id in ids.values())
    assert all(_synced_pending(pend, node_id) for node_id in ids.values())
    assert pend.main.agent_runs._runs == {}


@pytest.mark.parametrize("route", ["cli", "execute", "execute-node"])
def test_control_an_admitted_run_makes_them_normal_and_keeps_its_agent_run(pend, route):
    ids = _chain(pend)
    response = _run(pend, route, ids["+b"])
    assert response.status_code == 200, response.text
    assert all(pending_nodes.owner(pend.graph.nodes[node_id]) is None for node_id in ids.values())


# ---------------------------------------------------------------------------
# C2: the canvas header on the filed path


def test_C2_a_filed_revision_compares_the_canvas_header_with_the_filed_canvas(monkeypatch):
    import main
    from fastapi import HTTPException

    current = main._workspace_context()
    filed_revision = "rev-filed"
    epoch = main.canvas_undo_book.epoch(current["activeProjectId"])
    monkeypatch.setitem(main._filed_canvases, filed_revision, ("41", dict(current), epoch))
    token = main._request_canvas_revision.set("41")
    try:
        main._check_workspace_revision(filed_revision)  # the filed canvas: admitted
    finally:
        main._request_canvas_revision.reset(token)
    token = main._request_canvas_revision.set(str(epoch))
    try:
        with pytest.raises(HTTPException) as refused:
            main._check_workspace_revision(filed_revision)  # the live epoch isn't the filed one
        assert refused.value.status_code == 409
    finally:
        main._request_canvas_revision.reset(token)


def test_C2_without_a_revision_the_canvas_header_is_still_checked():
    import main
    from fastapi import HTTPException

    token = main._request_canvas_revision.set("not-this-canvas")
    try:
        with pytest.raises(HTTPException) as refused:
            main._check_workspace_revision()
        assert refused.value.status_code == 409
    finally:
        main._request_canvas_revision.reset(token)


# ---------------------------------------------------------------------------
# The epoch base


BASE = 1_793_000_000_000


def test_an_unreadable_file_starts_from_the_boot_base_and_says_so(tmp_path):
    path = tmp_path / "canvas-revisions.json"
    path.write_text("{not json")
    book = CanvasUndoBook(persist_path=path, unrestored_base=BASE, prior_state=True)
    assert book.epoch("p_one") == BASE
    assert book.epoch(None) == BASE
    assert book.restored is False
    # The base is kept, so the next boot restores it.
    assert json.loads(path.read_text())["base"] == BASE
    again = CanvasUndoBook(persist_path=path, unrestored_base=BASE + 5, prior_state=True)
    assert again.restored is True
    assert again.epoch("p_one") == BASE


def test_a_missing_file_after_a_saved_canvas_starts_from_the_base(tmp_path):
    book = CanvasUndoBook(persist_path=tmp_path / "canvas-revisions.json", unrestored_base=BASE, prior_state=True)
    assert book.restored is False
    assert book.epoch("p_one") == BASE


def test_a_first_run_starts_at_zero_and_is_restored(tmp_path):
    book = CanvasUndoBook(persist_path=tmp_path / "canvas-revisions.json", unrestored_base=BASE, prior_state=False)
    assert book.restored is True
    assert book.epoch("p_one") == 0
    assert not (tmp_path / "canvas-revisions.json").exists()


def test_memory_only_starts_from_the_base(tmp_path):
    book = CanvasUndoBook(unrestored_base=BASE)
    assert book.restored is False
    assert book.epoch(None) == BASE
    assert list(tmp_path.iterdir()) == []


def test_epochs_from_the_base_move_on_and_survive_a_restart(tmp_path):
    path = tmp_path / "canvas-revisions.json"
    book = CanvasUndoBook(persist_path=path, unrestored_base=BASE, prior_state=True)
    book.forget_project("p_one", "cleared")
    again = CanvasUndoBook(persist_path=path, unrestored_base=BASE + 99, prior_state=True)
    assert again.epoch("p_one") == BASE + 1
    assert again.epoch("p_two") == BASE


def test_mains_book_has_a_boot_base():
    import main

    assert main.canvas_undo_book._unrestored_base is not None
    assert main.canvas_undo_book._unrestored_base > 1_700_000_000_000


def test_the_sync_says_when_revisions_were_not_restored(api, monkeypatch):  # noqa: F811
    main = api.main
    monkeypatch.setattr(main, "canvas_undo_book", CanvasUndoBook(unrestored_base=BASE))
    exported = api.client.get("/api/graph/export").json()
    assert exported["canvasRevision"] == str(BASE)
    assert exported["canvasRevisionRestored"] is False


def test_control_a_restored_sync_has_no_flag(api, monkeypatch):  # noqa: F811
    main = api.main
    monkeypatch.setattr(main, "canvas_undo_book", CanvasUndoBook())
    assert "canvasRevisionRestored" not in api.client.get("/api/graph/export").json()
