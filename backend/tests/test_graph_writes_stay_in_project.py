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

# Round 11 (review 10, item 5): true after a switch away and back to the same project too.
MOVED = ("The open project changed since this started, so nothing was changed. Read the canvas again "
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


# -- round 11 (review 10): a run writes back only to the canvas it started on ---------------
#
# F4: a Clear during a registered run let ids start again, and the run's
# outputs then landed on whatever node held the id (no type check). Both
# layers: a Clear waits for registered runs, as a switch, an import and a
# delete of the open project do (_project_replacement_guard); and a run notes
# its project and id epoch when it registers, and every write-back from it
# (outputs, params, node errors, the canvas's node events, Cinema merges)
# drops itself if either moved.

import httpx  # noqa: E402

CLEAR_REFUSED = "Cannot clear the canvas while a run is active. Wait for the run to finish or stop it first."
# GM (round 11): the person's canvas shows "Couldn't clear the canvas." then this.
CLEAR_REFUSED_PERSON = "A run is still going. Wait for it to finish or stop it first."


def _ac(main: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://testserver")


async def _until(check: Any, *, seconds: float = 5.0) -> None:
    for _ in range(int(seconds / 0.01)):
        if check():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("timed out waiting")


def _held_run(race: Race, monkeypatch, events: Any) -> dict[str, Any]:
    """execute_graph waits at a gate, then changes its text-input params (as
    a handler that enriches params does) and emits ``events(run_id)``."""
    main = race.main
    gate: dict[str, Any] = {}

    async def fake_execute_graph(*, nodes, emit, run_id, **_kwargs):
        gate["ev"] = asyncio.Event()
        await gate["ev"].wait()
        for node in nodes:
            if node.definition_id == "text-input":
                node.params["value"] = "OLD RUN PARAMS"
        for event in events(run_id):
            await emit(event)

    monkeypatch.setattr(main, "execute_graph", fake_execute_graph)
    monkeypatch.setattr(main, "validate_graph", lambda *a, **k: [])
    return gate


def _old_run_events(run_id: str) -> list[Any]:
    from models.events import ErrorEvent, ExecutedEvent, ExecutingEvent

    return [ExecutingEvent(run_id=run_id, node_id="n1"),
            ExecutedEvent(run_id=run_id, node_id="n1", outputs={"text": {"type": "Text", "value": "OLD RUN OUTPUT"}}),
            ExecutingEvent(run_id=run_id, node_id="n2"),
            ErrorEvent(run_id=run_id, node_id="n2", error="OLD RUN FAILURE")]


async def _start(c: httpx.AsyncClient, race: Race, route: str, target: str) -> str:
    if route == "agent":
        started = await c.post("/api/graph/run", headers=AGENT, json={"targetNodeId": target, "wait": 0})
    else:
        nodes = [{"id": node_id, "definitionId": node["definitionId"], "params": node.get("params") or {}}
                 for node_id, node in race.graph.nodes.items()]
        started = await c.post("/api/execute", headers=PERSON, json={"nodes": nodes, "edges": []})
    assert started.status_code == 200, started.text
    return started.json()["runId"]


async def _finish(c: httpx.AsyncClient, race: Race, gate: dict[str, Any], run_id: str) -> None:
    gate["ev"].set()
    record = race.main.execution_runs.get(run_id)
    await asyncio.wait_for(asyncio.gather(record.task, return_exceptions=True), timeout=5)
    await asyncio.sleep(0)


@pytest.mark.parametrize("who", ["agent", "person"])
def test_a_clear_waits_for_a_registered_run_like_a_switch(race, monkeypatch, who):
    """F4, the guard: the agent's or the person's Clear during an agent's run
    is refused with the switch's own words, and the run lands on its node."""
    main = race.main
    t1 = race.graph.add_node("text-input", {"value": "old"}, position={"x": 0, "y": 0})
    race.graph.add_node("text-input", {"value": "old two"}, position={"x": 0, "y": 100})
    gate = _held_run(race, monkeypatch, _old_run_events)

    async def go():
        async with _ac(main) as c:
            run_id = await _start(c, race, "agent", t1)
            await _until(lambda: "ev" in gate)
            cleared = await c.request("DELETE", "/api/graph?force=true", headers=AGENT if who == "agent" else PERSON)
            await _finish(c, race, gate, run_id)
            after = await c.request("DELETE", "/api/graph?force=true", headers=AGENT if who == "agent" else PERSON)
            return cleared, after

    cleared, after = asyncio.run(go())
    assert cleared.status_code == 409, cleared.text
    assert cleared.json()["detail"] == (CLEAR_REFUSED if who == "agent" else CLEAR_REFUSED_PERSON)
    assert after.status_code == 200, after.text  # once the run ended
    kinds = [e["kind"] for e in race.events()]
    assert kinds.count("canvas.cleared") == 1
    assert kinds.index("canvas.cleared") > max(i for i, k in enumerate(kinds) if k.startswith("run."))


@pytest.mark.parametrize("route", ["agent", "canvas"])
def test_a_runs_write_backs_drop_once_its_canvas_was_cleared(race, monkeypatch, route):
    """F4 with the Clear guard bypassed: ids start again, the person adds new
    text nodes n1 and n2 (the same type, so no type check can catch it), and
    the old run's outputs, params, node error and node events reach none of
    them; the journal says nothing about a write that didn't happen."""
    main = race.main
    t1 = race.graph.add_node("text-input", {"value": "old"}, position={"x": 0, "y": 0})
    race.graph.add_node("text-input", {"value": "old two"}, position={"x": 0, "y": 100})
    gate = _held_run(race, monkeypatch, _old_run_events)
    monkeypatch.setattr(main, "_project_replacement_guard", lambda *_a, **_k: None)

    async def go():
        async with _ac(main) as c:
            run_id = await _start(c, race, route, t1)
            await _until(lambda: "ev" in gate)
            cleared = await c.request("DELETE", "/api/graph?force=true", headers=PERSON)
            assert cleared.status_code == 200, cleared.text
            for value in ("new", "new two"):
                made = await c.post("/api/graph/node", headers=PERSON, json={
                    "definitionId": "text-input", "params": {"value": value}, "position": {"x": 0, "y": 0}})
                assert made.status_code == 200, made.text
            mark = len(race.sent), race.events()[-1]["seq"]
            await _finish(c, race, gate, run_id)
            return run_id, mark

    run_id, (sent_before, seq_before) = asyncio.run(go())
    assert sorted(race.graph.nodes) == ["n1", "n2"]
    assert race.graph.nodes["n1"]["params"] == {"value": "new"}
    assert race.graph.nodes["n2"]["params"] == {"value": "new two"}
    assert not race.graph.nodes["n1"].get("outputs")
    assert main.node_errors.get("n2") is None
    late = [m for m in race.sent[sent_before:] if m.get("nodeId") in ("n1", "n2")]
    assert late == [], late
    journaled = [e["kind"] for e in race.events() if e["seq"] > seq_before and e["kind"].startswith("run.node")]
    assert journaled == []
    # The run itself still ends and says so.
    assert main.execution_runs.get(run_id).status in {"completed", "failed"}


def test_a_runs_write_backs_drop_once_its_unfiled_canvas_started_again(race, monkeypatch):
    """The sweep's delete case: the open project deleted, the unfiled canvas
    used, a project made and deleted again: the unfiled canvas is new (ids
    from n1), so its id epoch moves with the delete, in the same step."""
    main = race.main
    from services.agent_presence import _request_headers

    async def delete_open() -> None:
        held = _request_headers.set(PERSON)
        try:
            catalog = race.store.read()
            await main.delete_saved_project(catalog["activeProjectId"], {"workspaceRevision": catalog["workspaceRevision"]})
        finally:
            _request_headers.reset(held)

    asyncio.run(delete_open())
    assert race.store.read()["activeProjectId"] is None
    t1 = race.graph.add_node("text-input", {"value": "old"}, position={"x": 0, "y": 0})
    race.graph.add_node("text-input", {"value": "old two"}, position={"x": 0, "y": 100})
    gate = _held_run(race, monkeypatch, _old_run_events)
    monkeypatch.setattr(main, "_project_replacement_guard", lambda *_a, **_k: None)

    async def go():
        async with _ac(main) as c:
            run_id = await _start(c, race, "agent", t1)
            await _until(lambda: "ev" in gate)
            made = await c.post("/api/projects", headers=PERSON, json={
                "name": "Brief", "workspaceRevision": race.store.read()["workspaceRevision"]})
            assert made.status_code == 200, made.text
            await delete_open()
            assert race.store.read()["activeProjectId"] is None
            for value in ("new", "new two"):
                race.graph.add_node("text-input", {"value": value}, position={"x": 0, "y": 0})
            await _finish(c, race, gate, run_id)

    asyncio.run(go())
    assert race.graph.nodes["n1"]["params"] == {"value": "new"}
    assert not race.graph.nodes["n1"].get("outputs")
    assert main.node_errors.get("n2") is None


def test_a_cinema_shot_merges_nothing_once_its_canvas_was_cleared(race, monkeypatch):
    """The Cinema shot path writes back through its own merge (by node id)."""
    main = race.main
    scene = {"version": 1, "base": {"model": "nano-banana"}, "aspectRatio": "1:1",
             "shots": [{"id": "opening", "prompt": "local fixture"}]}
    target = race.graph.add_node("cinema-scene", {"scene": scene}, position={"x": 0, "y": 0})
    gate: dict[str, Any] = {}

    async def handler(node, inputs, _keys):
        gate["ev"] = asyncio.Event()
        await gate["ev"].wait()
        return {"shot_opening": {"type": "Image", "value": "/old-run.png"}}

    monkeypatch.setattr(main, "get_handler_registry", lambda **_kwargs: {"cinema-scene": handler})
    monkeypatch.setattr(main, "validate_graph", lambda *a, **k: [])
    monkeypatch.setattr(main, "_project_replacement_guard", lambda *_a, **_k: None)

    async def go():
        async with _ac(main) as c:
            nodes, edges = race.graph.to_execute_format()
            started = await c.post("/api/cinema/generate-shot", headers=PERSON, json={
                "nodes": nodes, "edges": edges, "nodeId": target, "shotId": "opening", "runId": "held-shot"})
            assert started.status_code == 200, started.text
            await _until(lambda: "ev" in gate)
            cleared = await c.request("DELETE", "/api/graph?force=true", headers=PERSON)
            assert cleared.status_code == 200, cleared.text
            race.graph.add_node("cinema-scene", {"scene": scene}, position={"x": 0, "y": 0})
            await _finish(c, race, gate, "held-shot")

    asyncio.run(go())
    assert list(race.graph.nodes) == ["n1"]
    node = race.graph.nodes["n1"]
    assert "shot_opening" not in (node.get("outputs") or {})
    assert node["params"]["scene"]["shots"][0].get("output") is None


def test_a_write_fenced_before_a_clear_refuses_inside_the_clears_awaits(race, monkeypatch):
    """F6: Clear moved the id epoch only after awaiting its status broadcast;
    an agent's PUT whose lookup ended in that window passed its fence and
    changed the node the person had just added (ids started again)."""
    main = race.main
    a1 = _universal(race, "openai/gpt-4o")
    real_bcast = main.manager.broadcast_raw
    gate: dict[str, Any] = {}

    async def bcast(data):
        await real_bcast(data)
        if gate.get("arm") and "status" in str(data.get("type", "")).lower():
            gate["arm"] = False
            gate["made"] = race.graph.add_node("openrouter-universal", {"model": "anthropic/claude-b"},
                                               position={"x": 0, "y": 0})
            gate["parked"].set()
            await gate["go"].wait()
    monkeypatch.setattr(main.manager, "broadcast_raw", bcast)

    async def look(wanted):
        gate["parked"], gate["go"] = asyncio.Event(), asyncio.Event()
        gate["arm"] = True
        gate["clear"] = asyncio.ensure_future(main.clear_graph(force=True))
        await gate["parked"].wait()
        asyncio.get_running_loop().call_later(0.05, gate["go"].set)
        return _no_catalog(wanted)
    monkeypatch.setattr(main, "_look_up_models", look)

    async def go():
        async with _ac(main) as c:
            status = await c.post("/api/canvas/status", headers=CLAUDE, json={"text": "watching", "nodeId": a1})
            assert status.status_code == 200, status.text
            answer = await c.put(f"/api/graph/node/{a1}", headers=AGENT, json={"params": {"model": "openai/gpt-5"}})
            await gate["clear"]
            return answer

    answer = asyncio.run(go())
    assert gate.get("made") == a1  # the window happened: ids started again
    _refused(answer, RESTARTED)
    assert race.graph.nodes[a1]["params"]["model"] == "anthropic/claude-b"


def test_an_agents_run_shows_ran_only_once_it_is_registered(race, monkeypatch):
    """F3: run_graph showed "Ran X" (the cursor and the Agent log) before its
    second fence, so a run refused there still logged "Ran X". Now the line
    goes out after the run registered: a switch tried during it is refused
    (a run is active), and nothing says "Ran" for a run that didn't start."""
    main = race.main
    t1 = race.graph.add_node("text-input", {"value": "hello"}, position={"x": 0, "y": 0})
    real = main._show_agent
    state: dict[str, Any] = {}

    async def show(*args, **kwargs):
        await real(*args, **kwargs)
        if "switched" not in state:
            state["switched"] = True
            state["registered"] = main.execution_runs.has_active()
            try:
                await race.switch()
                state["switch"] = "opened"
            except Exception as exc:  # noqa: BLE001 - the refusal is the point
                state["switch"] = getattr(exc, "detail", repr(exc))
    monkeypatch.setattr(main, "_show_agent", show)
    answer = race.client.post("/api/graph/run", headers=AGENT, json={"targetNodeId": t1, "wait": 5})
    assert state.get("registered") is True, state
    assert state["switch"] == "Cannot switch projects while a run is active. Wait for the run to finish or stop it first."
    assert answer.status_code == 200, answer.text
    assert race.store.read()["activeProjectId"] == race.active


def test_an_agents_run_refused_by_its_fence_never_says_it_ran(race, monkeypatch):
    t1 = race.graph.add_node("text-input", {"value": "hello"}, position={"x": 0, "y": 0})
    _switch_in(race, monkeypatch, "_measure_run_inputs")
    answer = race.client.post("/api/graph/run", headers=AGENT, json={"targetNodeId": t1, "wait": 5})
    _refused(answer)
    said = [m for m in race.sent if m.get("type") == "agentPresence"]
    assert not [m for m in said if (m.get("did") or {}).get("verb") == "Ran" or "Running" in str(m.get("say"))], said


@pytest.mark.parametrize("route", ["/api/execute", "/api/execute-node", "/api/cinema/generate-shot"])
def test_a_canvas_run_refuses_a_moved_canvas_before_its_approval_and_spend(race, monkeypatch, route):
    """Item 4: execute, execute_node and generate_cinema_shot checked the fence
    after taking the approval and counting the spend. Now right after the
    inputs are measured, as run_graph does: the approval and the spend
    check are never reached."""
    main = race.main
    if route == "/api/cinema/generate-shot":
        scene = {"version": 1, "base": {"model": "nano-banana"}, "aspectRatio": "1:1",
                 "shots": [{"id": "opening", "prompt": "local fixture"}]}
        a1 = race.graph.add_node("cinema-scene", {"scene": scene}, position={"x": 0, "y": 0})
        monkeypatch.setattr(main, "validate_graph", lambda *a, **k: [])
    else:
        a1 = race.graph.add_node("text-input", {"value": "hello"}, position={"x": 0, "y": 0})
    nodes, edges = race.graph.to_execute_format()
    calls: list[str] = []
    for name in ("_check_run_approval", "_require_spend_approval"):
        real = getattr(main, name)

        def spy(*args, _real=real, _name=name, **kwargs):
            calls.append(_name)
            return _real(*args, **kwargs)
        monkeypatch.setattr(main, name, spy)
    _switch_in(race, monkeypatch, "_measure_run_inputs")
    body: dict[str, Any] = {"nodes": nodes, "edges": edges}
    if route == "/api/execute-node":
        body["targetNodeId"] = a1
    if route == "/api/cinema/generate-shot":
        body.update({"nodeId": a1, "shotId": "opening"})
    answer = race.client.post(route, headers=PERSON, json=body)
    _refused(answer, PERSON_LINE)
    assert calls == []
    assert race.main.execution_runs.has_active() is False
    assert not race.main._spend_holds


def test_a_runs_provider_recovery_reaches_no_node_once_its_canvas_was_cleared(race, monkeypatch):
    """The coordinator, round 11: the recovery event of a run whose canvas was
    cleared since (guard bypassed; unreachable today) neither sets the new
    node's recovery params nor goes to the canvas, which would put it on its
    node by id. The run-and-node checkpoint itself is still kept."""
    from models.events import ProviderRecoveryEvent

    main = race.main
    t1 = race.graph.add_node("text-input", {"value": "old"}, position={"x": 0, "y": 0})
    gate = _held_run(race, monkeypatch, lambda run_id: [ProviderRecoveryEvent(
        run_id=run_id, node_id="n1", resume_operation_id="op_old_run")])
    monkeypatch.setattr(main, "_project_replacement_guard", lambda *_a, **_k: None)
    kept: list[dict[str, Any]] = []
    monkeypatch.setattr(main.provider_recovery_store, "set", lambda **record: kept.append(record))

    async def go():
        async with _ac(main) as c:
            run_id = await _start(c, race, "agent", t1)
            await _until(lambda: "ev" in gate)
            cleared = await c.request("DELETE", "/api/graph?force=true", headers=PERSON)
            assert cleared.status_code == 200, cleared.text
            race.graph.add_node("text-input", {"value": "new"}, position={"x": 0, "y": 0})
            mark = len(race.sent)
            await _finish(c, race, gate, run_id)
            return mark

    mark = asyncio.run(go())
    assert race.graph.nodes["n1"]["params"] == {"value": "new"}
    late = [m for m in race.sent[mark:] if m.get("type") == "providerRecovery"]
    assert late == [], late
    assert [record["resume_operation_id"] for record in kept] == ["op_old_run"]
