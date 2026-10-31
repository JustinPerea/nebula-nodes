"""Round 21 of PR #195: review 20's backend findings and GM's round 21 lines.

- M-1. An agent reopening the project the tab shows reloads it from what was
  saved; the tab's handoff then keeps its typing on the live graph too, not
  only in the stored copy (the next read or overlay put the live values back).
- L-3. A proposal keeps the canvas revision it was made on; Accept refuses
  when the canvas moved since (a clear landing while it awaited).
- L-5. The revisions file is saved as a merge: another book's later write
  never moves a project's revision backwards.
- L-6. A handoff's ``pendingParams`` and ``pendingLabels`` come only from a
  person's tab; anyone else gets 409 with GM's line (G4: "the change came
  from an agent").
- G4. The handoff's refusal reads "Nebula couldn't keep this save's unsent
  changes in the project because <why>, so nothing was saved."
- G5. Recovered copies are numbered: "Recovered <project>", then
  "Recovered <project> 2", 3 and so on (GM r23 a on PR #199); a new copy never reuses an earlier one.
"""
from __future__ import annotations

import json

from services.canvas_undo import CanvasUndoBook
from tests.conftest import CANVAS_PARAMS_VERSION, PERSON
from tests.test_round20_fence import AGENT, TAB, _handoff, _revision, _stored, _switch_away, _with, api  # noqa: F401


def _refusal(why: str) -> str:
    return f"Nebula couldn't keep this save's unsent changes in the project because {why}, so nothing was saved."


# ---------------------------------------------------------------------------
# M-1: a reopen keeps the typing on the live graph and in the stored project


def _reopen(api) -> tuple[str, dict]:
    old_revision = _revision(api)
    opened = api.client.post(f"/api/projects/{api.first}/open", headers=AGENT, json={"workspaceRevision": old_revision})
    assert opened.status_code == 200, opened.text
    return old_revision, api.client.get(f"/api/projects/{api.first}").json()["snapshot"]


def test_M1_an_agents_reopen_keeps_the_handoffs_typing_live_and_stored(api):
    node = api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    old_revision, saved = _reopen(api)
    answer = _handoff(api, old_revision, _with(saved, node, params={"value": "typed"}),
                      pendingParams={node: {"value": "typed"}})
    assert answer.status_code == 200, answer.text
    assert answer.json()["handoff"] is True
    assert api.graph.nodes[node]["params"]["value"] == "typed"
    # A read of the open project overlays the live graph: it still says "typed".
    assert _stored(api, node)["data"]["params"]["value"] == "typed"
    assert api.client.get("/api/graph/export").json()["nodes"][0]["data"]["params"]["value"] == "typed"


def test_M1_a_reopen_keeps_an_unsent_name_live(api):
    node = api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    old_revision, saved = _reopen(api)
    answer = _handoff(api, old_revision, _with(saved, node, label="Hero prompt"), pendingLabels={node: "Hero prompt"})
    assert answer.status_code == 200, answer.text
    assert api.graph.nodes[node].get("label") == "Hero prompt"
    assert _stored(api, node)["data"]["label"] == "Hero prompt"


def test_M1_the_reopens_live_change_is_broadcast(api):
    node = api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    old_revision, saved = _reopen(api)
    api.sent.clear()
    assert _handoff(api, old_revision, _with(saved, node, params={"value": "typed"}),
                    pendingParams={node: {"value": "typed"}}).status_code == 200
    syncs = [message for message in api.sent if message.get("type") == "graphSync"]
    assert syncs and syncs[-1]["nodes"][0]["data"]["params"]["value"] == "typed"


def test_M1_control_a_switch_away_leaves_the_live_graph_alone(api):
    node = api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    old_revision, saved = _switch_away(api)
    assert _handoff(api, old_revision, _with(saved, node, params={"value": "typed"}),
                    pendingParams={node: {"value": "typed"}}).status_code == 200
    # The live graph is the other project's now.
    assert node not in api.graph.nodes or api.graph.nodes[node]["params"].get("value") != "typed"
    assert _stored(api, node)["data"]["params"]["value"] == "typed"


# ---------------------------------------------------------------------------
# L-6 and G4: only a person's tab sends the unsent changes


def test_L6_an_agents_handoff_with_pending_params_is_refused(api):
    node = api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    old_revision, saved = _switch_away(api)
    answer = api.client.put(f"/api/projects/{api.first}", headers={**AGENT, **CANVAS_PARAMS_VERSION, "X-Nebula-Workspace-Revision": old_revision},
                            json={"snapshot": _with(saved, node, params={"value": "agent overwrote it"}),
                                  "workspaceRevision": old_revision, "pendingParams": {node: {"value": "x"}}})
    assert answer.status_code == 409, answer.text
    assert answer.json()["detail"] == _refusal("the change came from an agent")
    assert _stored(api, node)["data"]["params"]["value"] == "a"


def test_L6_a_person_without_a_tab_is_refused_too(api):
    node = api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    old_revision, saved = _switch_away(api)
    answer = api.client.put(f"/api/projects/{api.first}", headers={**PERSON, "X-Nebula-Workspace-Revision": old_revision},
                            json={"snapshot": _with(saved, node, params={"value": "x"}),
                                  "workspaceRevision": old_revision, "pendingLabels": {node: "Name"}})
    assert answer.status_code == 409, answer.text
    assert answer.json()["detail"] == _refusal("the change came from an agent")


def test_L6_control_an_agents_handoff_without_pending_keys_is_kept_as_before(api):
    api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    old_revision, saved = _switch_away(api)
    answer = api.client.put(f"/api/projects/{api.first}", headers={**AGENT, **CANVAS_PARAMS_VERSION, "X-Nebula-Workspace-Revision": old_revision},
                            json={"snapshot": saved, "workspaceRevision": old_revision})
    assert answer.status_code == 200, answer.text


def test_G4_a_node_the_save_lacks_reads_the_node_was_removed(api):
    node = api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    old_revision, saved = _switch_away(api)
    answer = _handoff(api, old_revision, {**saved, "nodes": []}, pendingParams={node: {"value": "typed"}})
    assert answer.status_code == 409, answer.text
    assert answer.json()["detail"] == _refusal("the node was removed")


def test_G4_another_kind_of_node_reads_a_nodes_type_changed(api):
    node = api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    old_revision, saved = _switch_away(api)
    snapshot = _with(saved, node, definition="combine-text")
    snapshot["nodes"][0]["data"]["params"] = {"separator": ","}
    answer = _handoff(api, old_revision, snapshot, pendingParams={node: {"separator": ","}})
    assert answer.status_code == 409, answer.text
    assert answer.json()["detail"] == _refusal("a node's type changed")


# ---------------------------------------------------------------------------
# L-3: Accept refuses on a canvas that moved since the proposal was made


def test_L3_a_proposal_keeps_the_canvas_it_was_made_on_and_accept_refuses_when_it_moved(api, monkeypatch):
    main = api.main
    from services.canvas_proposals import Proposal

    proposal = Proposal.__new__(Proposal)
    proposal.status = "open"
    proposal.project_id = main._workspace_context()["activeProjectId"]
    proposal.canvas_revision = main._canvas_revision()
    main._ensure_still_decidable(proposal)  # the same canvas: decidable
    main.canvas_undo_book.advance_epoch(proposal.project_id)
    import pytest
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as refused:
        main._ensure_still_decidable(proposal)
    assert refused.value.status_code == 409


# ---------------------------------------------------------------------------
# L-5: the revisions file is saved as a merge


def test_L5_two_books_on_one_file_never_move_a_revision_backwards(tmp_path):
    path = tmp_path / "canvas-revisions.json"
    first = CanvasUndoBook(persist_path=path)
    second = CanvasUndoBook(persist_path=path)
    for _ in range(3):
        first.forget_project("p", "cleared")
    second.forget_project("q", "cleared")
    stored = json.loads(path.read_text())
    assert stored["projects"]["p"] == 3
    assert stored["projects"]["q"] == 1
    assert CanvasUndoBook(persist_path=path).epoch("p") == 3


def test_L5_a_corrupt_file_is_not_rewritten_with_only_the_projects_in_memory(tmp_path):
    path = tmp_path / "canvas-revisions.json"
    other = CanvasUndoBook(persist_path=path)
    other.forget_project("kept", "cleared")
    book = CanvasUndoBook(persist_path=path)
    book.forget_project("p", "cleared")
    assert json.loads(path.read_text())["projects"] == {"kept": 1, "p": 1}


# ---------------------------------------------------------------------------
# G5: recovered copies are numbered and never reused


def _recover(api, recovery_id: str):
    snapshot = api.client.get(f"/api/projects/{api.first}").json()["snapshot"]
    return api.client.post("/api/projects/recover", headers=PERSON,
                           json={"sourceProjectId": api.first, "snapshot": snapshot, "recoveryId": recovery_id})


def test_G5_recovered_copies_are_numbered(api):
    names = []
    for index in range(3):
        answer = _recover(api, f"{index:032x}")
        assert answer.status_code == 200, answer.text
        names.append(answer.json()["project"]["name"])
    # GM r29 of PR #199, 2: " copy", then " copy 2".
    assert names == ["Recovered Active", "Recovered Active copy", "Recovered Active copy 2"]


def test_G5_a_retry_of_the_same_copy_is_the_same_copy(api):
    first = _recover(api, "a" * 32).json()["project"]
    again = _recover(api, "a" * 32).json()["project"]
    assert again["id"] == first["id"] and again["name"] == "Recovered Active"
