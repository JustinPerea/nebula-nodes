"""A write that awaits lands only on the project that was open when it was asked (review 9 of PR #114, round 10).

Review 9's Q5: an agent's model change (PUT /api/graph/node/{id}, or an edit
through /api/graph/apply) awaits the model catalog, then writes by node id.
Agents send no workspace revision, so a project switch during that await
landed the change on the other project's node with the same id (node ids
restart per project): both 200, B's n1 model changed.

Every route that awaits and then writes the live graph (by node or edge id,
or a new node, a whole graph, a run's outputs) notes the open project (the
workspace revision, which turns over on every open, create and delete) and
the canvas's id epoch (which turns over on a clear or an import) before its
first await, and checks both again right before it writes. If either moved,
it refuses with 409 and nothing changes. Each test is one distinct shape:
the await the switch lands in, and the write it would have made.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest

from tests.conftest import PERSON
from tests.test_canvas_pins import AGENT, api  # noqa: F401  (fixture)
from tests.test_journal_write_project import CLAUDE, KEY, Race, _png

MOVED = ("Another project is open now, so nothing was changed. Read the canvas again "
         "and send the change again if it still fits.")
RESTARTED = ("The canvas was cleared or replaced since, so nothing was changed. Read the canvas again "
             "and send the change again if it still fits.")
# The person's canvas reads its own out-of-date line (services/refusal_copy.py).
PERSON_LINE = "This canvas is out of date. Open the current project before editing or running it."


@pytest.fixture
def race(api, monkeypatch):  # noqa: F811
    return Race(api, monkeypatch)


def _universal(race: Race, model: str) -> str:
    return race.graph.add_node("openrouter-universal", {"model": model}, position={"x": 0, "y": 0})


def _b_twin(race: Race) -> str:
    """On B, a node with the id A's node had, of the same model."""
    return race.graph.add_node("openrouter-universal", {"model": "anthropic/claude-b"}, position={"x": 9, "y": 9})


def _switch_in(race: Race, monkeypatch, name: str, *, then: Any = None, back: bool = False,
               result: Any = None) -> dict[str, Any]:
    """Replace ``main.<name>`` (an awaited helper) with one that, the first
    time, opens B (and runs ``then``; with ``back``, opens A again), then
    returns ``result(*args)`` or the real helper's answer."""
    main = race.main
    real = getattr(main, name)
    state: dict[str, Any] = {}

    async def hooked(*args: Any, **kwargs: Any) -> Any:
        if "switched" not in state:
            state["switched"] = True
            await race.switch()
            if then is not None:
                state["then"] = then()
            if back:
                from services.agent_presence import _request_headers

                held = _request_headers.set(PERSON)
                try:
                    revision = race.store.read()["workspaceRevision"]
                    await main.open_saved_project(race.active, {"workspaceRevision": revision})
                finally:
                    _request_headers.reset(held)
        if result is not None:
            return result(*args, **kwargs)
        answer = real(*args, **kwargs)
        return await answer if asyncio.iscoroutine(answer) else answer

    monkeypatch.setattr(main, name, hooked)
    return state


def _no_catalog(wanted: Any) -> dict[Any, str]:
    return {key: "the catalog can't be read (test)" for key in wanted}


def _refused(answer: Any, detail: str = MOVED) -> None:
    assert answer.status_code == 409, answer.text
    assert answer.json()["detail"] == detail


# -- the agent's model change: Q5, both routes ------------------------------------------

@pytest.mark.parametrize("route", ["put", "apply"])
def test_an_agents_model_change_never_lands_on_the_project_opened_during_its_lookup(race, monkeypatch, route):
    a1 = _universal(race, "openai/gpt-4o")
    state = _switch_in(race, monkeypatch, "_look_up_models", then=lambda: _b_twin(race), result=_no_catalog)
    since = race.events()[-1]["seq"] if race.events() else 0
    if route == "put":
        answer = race.client.put(f"/api/graph/node/{a1}", headers=AGENT, json={"params": {"model": "openai/gpt-5"}})
    else:
        answer = race.client.post("/api/graph/apply", headers=AGENT, json={
            "params": [{"nodeId": a1, "params": {"model": "openai/gpt-5"}}]})
    _refused(answer)
    b1 = state["then"]
    assert b1 == a1  # the same id on B: the write would have found it
    assert race.store.read()["activeProjectId"] == race.other
    assert race.graph.nodes[b1]["params"]["model"] == "anthropic/claude-b"
    assert not [e for e in race.events() if e["seq"] > since and e["kind"] == "node.params"]
    # A kept its own model too.
    stored = race.store.read()["projects"][race.active]["snapshot"]["nodes"]
    assert [n["data"]["params"]["model"] for n in stored if n["id"] == a1] == ["openai/gpt-4o"]


def test_an_agents_edit_refuses_once_the_canvas_was_cleared_during_its_lookup(race, monkeypatch):
    """Same project, but its node ids started again (a clear): the epoch moved."""
    main = race.main
    a1 = _universal(race, "openai/gpt-4o")

    async def clear_then_add(wanted):
        await main.clear_graph(force=True)  # in-process: the TestClient isn't reentrant
        race.graph.add_node("openrouter-universal", {"model": "anthropic/claude-new"}, position={"x": 1, "y": 1})
        return _no_catalog(wanted)

    monkeypatch.setattr(main, "_look_up_models", clear_then_add)
    answer = race.client.post("/api/graph/apply", headers=AGENT, json={
        "params": [{"nodeId": a1, "params": {"model": "openai/gpt-5"}}]})
    _refused(answer, RESTARTED)
    assert race.graph.nodes[a1]["params"]["model"] == "anthropic/claude-new"


def test_an_agents_new_node_never_lands_on_the_project_opened_during_its_lookup(race, monkeypatch):
    _switch_in(race, monkeypatch, "_look_up_models", result=_no_catalog)
    answer = race.client.post("/api/graph/node", headers=AGENT, json={
        "definitionId": "openrouter-universal", "params": {"model": "openai/gpt-5"}})
    _refused(answer)
    assert race.store.read()["activeProjectId"] == race.other
    assert race.graph.nodes == {}
    assert not [e for e in race.events() if e["kind"] == "node.added"]


def test_a_proposal_is_never_made_on_the_project_opened_during_its_lookup(race, monkeypatch):
    a1 = race.graph.add_node("text-input", {"value": "a lighthouse"}, position={"x": 0, "y": 0})
    state = _switch_in(race, monkeypatch, "_look_up_models", result=_no_catalog,
                       then=lambda: race.graph.add_node("text-input", {"value": "B's own"}, position={"x": 0, "y": 0}))
    answer = race.client.post("/api/canvas/proposals", headers=CLAUDE, json={
        "note": "change it", "params": [{"nodeId": a1, "params": {"value": "a castle"}}]})
    _refused(answer)
    assert state["then"] == a1
    assert race.main.canvas_proposals.open_list() == []
    assert not [e for e in race.events() if e["kind"] == "proposal.created"]


def test_an_accept_refuses_when_the_project_was_switched_away_and_back_during_its_lookup(race, monkeypatch):
    a1 = race.graph.add_node("text-input", {"value": "a lighthouse"}, position={"x": 0, "y": 0})
    made = race.client.post("/api/canvas/proposals", headers=CLAUDE, json={
        "note": "change it", "params": [{"nodeId": a1, "params": {"value": "a castle"}}]})
    assert made.status_code == 201, made.text
    proposal_id = made.json()["proposal"]["id"]
    key = race.key(proposal_id)
    _switch_in(race, monkeypatch, "_look_up_models", back=True, result=_no_catalog)
    answer = race.client.post(f"/api/canvas/proposals/{proposal_id}/accept", headers={**PERSON, KEY: key}, json={})
    assert answer.status_code == 409, answer.text
    assert race.store.read()["activeProjectId"] == race.active
    assert race.graph.nodes[a1]["params"]["value"] == "a lighthouse"


def test_the_model_picker_never_lands_on_the_project_opened_during_its_lookup(race, monkeypatch):
    a1 = _universal(race, "openai/gpt-4o")
    data = {"inputs": [], "outputs": [], "params": {}, "providerMeta": {}}
    state = _switch_in(race, monkeypatch, "_universal_data", then=lambda: _b_twin(race),
                       result=lambda *_args, **_kw: data)
    answer = race.client.post(f"/api/graph/node/{a1}/model", headers=PERSON, json={"model": "openai/gpt-5"})
    _refused(answer, PERSON_LINE)
    assert race.graph.nodes[state["then"]]["params"]["model"] == "anthropic/claude-b"


def test_an_import_never_replaces_the_project_opened_during_its_check(race, monkeypatch):
    _switch_in(race, monkeypatch, "_ingress_verdict_off_loop",
               then=lambda: race.graph.add_node("text-input", {"value": "B's own"}, position={"x": 0, "y": 0}))
    answer = race.client.post("/api/graph/import", headers=AGENT, json={
        "nodes": [{"id": "x", "definitionId": "text-input", "params": {"value": "from a file"}}], "edges": []})
    _refused(answer)
    assert [n["params"]["value"] for n in race.graph.nodes.values()] == ["B's own"]


@pytest.mark.parametrize("who", ["person", "agent"])
def test_an_upload_never_adds_its_node_to_the_project_opened_while_it_was_read(race, monkeypatch, who):
    from starlette.datastructures import UploadFile

    real = UploadFile.read
    state: dict[str, Any] = {}

    async def read(self, *args: Any) -> bytes:
        if "switched" not in state:
            state["switched"] = True
            await race.switch()
        return await real(self, *args)

    monkeypatch.setattr(UploadFile, "read", read)
    answer = race.client.post("/api/uploads", headers=PERSON if who == "person" else AGENT,
                              data={"create_node": "true"}, files={"file": ("red.png", _png(), "image/png")})
    _refused(answer, PERSON_LINE if who == "person" else MOVED)
    assert race.graph.nodes == {}
    assert not [e for e in race.events() if e["kind"] == "node.added"]


# -- runs: the start comes after awaits (the spend check, the input sizes) ----------------

def test_an_agents_run_never_starts_on_the_project_opened_during_its_checks(race, monkeypatch):
    a1 = race.graph.add_node("text-input", {"value": "hello"}, position={"x": 0, "y": 0})
    _switch_in(race, monkeypatch, "_measure_run_inputs",
               then=lambda: race.graph.add_node("text-input", {"value": "B's own"}, position={"x": 0, "y": 0}))
    answer = race.client.post("/api/graph/run", headers=AGENT, json={"targetNodeId": a1, "wait": 5})
    _refused(answer)
    assert race.main.execution_runs.has_active() is False
    assert not [e for e in race.events() if e["kind"].startswith("run.")]
    assert "outputs" not in race.graph.nodes[a1] or not race.graph.nodes[a1]["outputs"]


@pytest.mark.parametrize("route", ["/api/execute", "/api/execute-node"])
def test_a_canvas_run_never_starts_on_the_project_opened_during_its_spend_check(race, monkeypatch, route):
    a1 = race.graph.add_node("text-input", {"value": "hello"}, position={"x": 0, "y": 0})
    _switch_in(race, monkeypatch, "_require_run_spend_approval", result=lambda *a, **k: None)
    body: dict[str, Any] = {"nodes": [{"id": a1, "definitionId": "text-input", "params": {"value": "hello"}}],
                            "edges": []}
    if route == "/api/execute-node":
        body["targetNodeId"] = a1
    answer = race.client.post(route, headers=PERSON, json=body)
    _refused(answer, PERSON_LINE)
    assert race.main.execution_runs.has_active() is False
    assert not [e for e in race.events() if e["kind"].startswith("run.")]


# -- item 6: a rolled-back upload node leaves the open canvas too --------------------------

def _upload_failing_with_a_switch_away_and_back(race, monkeypatch) -> Any:
    """The upload's sync opens B, then A again, then fails (Q4 case 3)."""
    main = race.main
    from services.agent_presence import _request_headers

    real = main.manager.broadcast_raw
    state: dict[str, Any] = {}

    async def hook(data: dict) -> None:
        await real(data)
        if "fired" not in state and data.get("type") == "graphSync":
            state["fired"] = True
            await race.switch()
            held = _request_headers.set(PERSON)
            try:
                revision = race.store.read()["workspaceRevision"]
                await main.open_saved_project(race.active, {"workspaceRevision": revision})
            finally:
                _request_headers.reset(held)
            raise RuntimeError("socket gone")

    monkeypatch.setattr(main.manager, "broadcast_raw", hook)
    answer = race.client.post("/api/uploads", headers=PERSON, data={"create_node": "true"},
                              files={"file": ("red.png", _png(), "image/png")})
    monkeypatch.setattr(main.manager, "broadcast_raw", real)
    return answer


def test_an_upload_rolled_back_off_the_live_graph_leaves_the_stored_project_too(race, monkeypatch):
    """The coordinator, round 10: the switch saved the upload's node into A's
    stored snapshot; the rollback takes it off the live graph and writes that
    through at once, so a crash right after can't bring it back."""
    answer = _upload_failing_with_a_switch_away_and_back(race, monkeypatch)
    assert answer.status_code == 500, answer.text
    stored = race.store.read()["projects"][race.active]
    images = [n for n in stored["snapshot"]["nodes"] if (n.get("data") or {}).get("definitionId") == "image-input"]
    assert images == [], images
    assert set(stored.get("_backendNodeIds") or []) == set(race.graph.nodes), stored.get("_backendNodeIds")


def test_an_upload_rolled_back_off_the_live_graph_resyncs_the_open_canvas(race, monkeypatch):
    """Q4 case 3: during the upload's failed sync the person opens B and then A
    again. A's reopen sent the canvas a graph with the upload's node (the
    switch had saved it into A); the rollback takes it off the live graph,
    so the canvas is synced again and holds what the backend holds."""
    main = race.main
    from services.agent_presence import _request_headers

    real = main.manager.broadcast_raw
    state: dict[str, Any] = {}

    async def hook(data: dict) -> None:
        await real(data)
        if "fired" not in state and data.get("type") == "graphSync":
            state["fired"] = True
            await race.switch()
            held = _request_headers.set(PERSON)
            try:
                revision = race.store.read()["workspaceRevision"]
                await main.open_saved_project(race.active, {"workspaceRevision": revision})
            finally:
                _request_headers.reset(held)
            raise RuntimeError("socket gone")

    monkeypatch.setattr(main.manager, "broadcast_raw", hook)
    answer = race.client.post("/api/uploads", headers=PERSON, data={"create_node": "true"},
                              files={"file": ("red.png", _png(), "image/png")})
    monkeypatch.setattr(main.manager, "broadcast_raw", real)
    assert answer.status_code == 500, answer.text
    assert race.store.read()["activeProjectId"] == race.active
    live = {node_id for node_id, node in race.graph.nodes.items() if node.get("definitionId") == "image-input"}
    assert live == set()
    last = [m for m in race.sent if m.get("type") == "graphSync"][-1]
    shown = [n for n in last.get("nodes") or [] if (n.get("data") or {}).get("definitionId") == "image-input"]
    assert shown == [], "the open canvas still shows the rolled-back node"
