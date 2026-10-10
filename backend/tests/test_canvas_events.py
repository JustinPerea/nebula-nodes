from __future__ import annotations

import asyncio
import io
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from cli.commands.canvas import run_watch
from cli.formatter import format_event, format_snapshot
from models.events import ErrorEvent, ExecutedEvent, ExecutingEvent
from services.agent_presence import AgentPresence
from services.canvas_events import (
    MAX_EVENT_BYTES,
    MAX_WAITERS,
    CanvasEventJournal,
    TooManyWaiters,
    actor_for_headers,
    param_changes,
    parse_kinds,
)
from services.cli_graph import CLIGraph
from services.selection_context import SelectionContextStore

PERSON = {"kind": "person"}
CODEX = {"kind": "agent", "id": "codex", "name": "Codex", "color": "#5B9DFF", "verified": True}
BROWSER = {"Origin": "http://localhost:5173"}
AGENT = {"X-Nebula-Agent": "Claude Code"}
PROJECT = "a" * 32


class Clock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


# -- actors and param diffs -------------------------------------------------

def test_actor_comes_from_identity_then_browser_origin_else_anonymous():
    assert actor_for_headers({"x-nebula-agent": "Claude Code"})["kind"] == "agent"
    assert actor_for_headers({"origin": "http://localhost:5173"}) == PERSON
    assert actor_for_headers({"origin": "file://"}) == PERSON
    assert actor_for_headers({"origin": "https://evil.example"}) == {"kind": "anonymous"}
    assert actor_for_headers({}) == {"kind": "anonymous"}
    assert actor_for_headers(None) == {"kind": "anonymous"}


def test_param_changes_reports_only_changed_keys_and_redacts():
    assert param_changes({"a": 1}, {"a": 1}) is None
    changes = param_changes(
        {"prompt": "cold", "seed": 1, "api_key": "old", "_editor": 1},
        {"prompt": "warm", "seed": 1, "api_key": "new", "_editor": 2, "quality": "low"},
    )
    assert changes == {
        "keys": ["api_key", "prompt", "quality"],
        "values": {"api_key": "<redacted>", "prompt": "warm", "quality": "low"},
    }
    assert param_changes({"gone": 1}, {}) == {"keys": ["gone"], "values": {"gone": None}}


def test_parse_kinds_accepts_groups_and_exact_kinds():
    assert parse_kinds("pin, node.params") == {"pin", "node.params"}
    assert parse_kinds("") is None
    with pytest.raises(ValueError):
        parse_kinds("node.exploded")


# -- journal ----------------------------------------------------------------

def test_seq_is_monotonic_and_events_carry_actor_project_and_time():
    clock = Clock()
    journal = CanvasEventJournal(clock=clock)
    journal.set_project(PROJECT)
    first = journal.publish("node.added", actor=PERSON, node_id="n1", data={"name": "Text"}, summary="added Text")
    clock.now += 1
    second = journal.publish("node.removed", actor=CODEX, node_id="n1")
    assert (first["seq"], second["seq"]) == (1, 2)
    assert first["at"] == 1_000_000 and second["at"] == 1_001_000
    assert first["projectId"] == PROJECT and first["actor"] == PERSON
    assert journal.latest == 2
    with pytest.raises(ValueError):
        journal.publish("node.exploded", actor=PERSON)


def test_after_defaults_to_now_and_cursor_resumes():
    journal = CanvasEventJournal()
    journal.publish("node.added", actor=PERSON)
    assert journal.read(after=None)["events"] == []
    journal.publish("node.moved", actor=PERSON)
    result = journal.read(after=1)
    assert [e["seq"] for e in result["events"]] == [2]
    assert result["cursor"] == 2 and result["gap"] is False and result["reset"] is False


def test_ring_eviction_reports_a_gap():
    journal = CanvasEventJournal(max_events=3)
    for _ in range(5):
        journal.publish("node.moved", actor=PERSON)
    result = journal.read(after=0)
    assert result["oldest"] == 3 and result["gap"] is True
    assert [e["seq"] for e in result["events"]] == [3, 4, 5]
    assert journal.read(after=2)["gap"] is False


def test_a_different_journal_id_resets_to_the_start_of_the_buffer():
    journal = CanvasEventJournal()
    journal.publish("node.added", actor=PERSON)
    journal.publish("node.added", actor=PERSON)
    result = journal.read(after=40, journal="0123456789ab")
    assert result["reset"] is True and result["journal"] == journal.journal_id
    assert [e["seq"] for e in result["events"]] == [1, 2]


def test_kind_filters_and_self_exclusion_still_advance_the_cursor():
    journal = CanvasEventJournal()
    journal.publish("node.params", actor=CODEX)
    journal.publish("pin.added", actor=PERSON)
    journal.publish("node.added", actor=PERSON)
    journal.publish("node.params", actor=CODEX)

    groups = journal.read(after=0, kinds={"node"})
    assert [e["seq"] for e in groups["events"]] == [1, 3, 4]
    exact = journal.read(after=0, kinds={"node.params"})
    assert [e["seq"] for e in exact["events"]] == [1, 4]

    others = journal.read(after=0, exclude_actor_id="codex")
    assert [e["seq"] for e in others["events"]] == [2, 3]
    assert others["cursor"] == 4  # the skipped own edit is scanned, never re-read

    only_mine = journal.read(after=2, exclude_actor_id="codex", kinds={"node.params"})
    assert only_mine["events"] == [] and only_mine["cursor"] == 4


def test_limit_sets_more_and_stops_the_cursor_at_the_last_returned_event():
    journal = CanvasEventJournal()
    for _ in range(5):
        journal.publish("node.moved", actor=PERSON)
    result = journal.read(after=0, limit=2)
    assert [e["seq"] for e in result["events"]] == [1, 2]
    assert result["more"] is True and result["cursor"] == 2


def test_oversized_values_are_dropped_and_strings_capped():
    journal = CanvasEventJournal()
    values = {f"k{i}": "x" * 150 for i in range(60)}
    event = journal.publish("node.params", actor=PERSON, data={"keys": sorted(values), "values": values})
    assert event["data"]["valuesOmitted"] is True and "values" not in event["data"]
    assert len(json.dumps(event["data"])) <= MAX_EVENT_BYTES
    capped = journal.publish("node.params", actor=PERSON, data={"keys": ["p"], "values": {"p": "y" * 500}})
    assert len(capped["data"]["values"]["p"]) == 161


def test_wait_wakes_on_publish():
    journal = CanvasEventJournal()

    async def scenario():
        async def later():
            await asyncio.sleep(0.05)
            journal.publish("node.added", actor=PERSON)

        task = asyncio.create_task(later())
        result = await journal.wait(after=None, wait=2)
        await task
        return result

    result = asyncio.run(scenario())
    assert [e["kind"] for e in result["events"]] == ["node.added"]
    assert result["timedOut"] is False


def test_wait_ignores_own_events_and_times_out():
    journal = CanvasEventJournal()

    async def scenario():
        async def later():
            await asyncio.sleep(0.02)
            journal.publish("node.params", actor=CODEX)

        task = asyncio.create_task(later())
        result = await journal.wait(after=None, wait=0.2, exclude_actor_id="codex")
        await task
        return result

    result = asyncio.run(scenario())
    assert result["events"] == [] and result["timedOut"] is True and result["cursor"] == 1


def test_waiter_cap():
    journal = CanvasEventJournal()

    async def scenario():
        tasks = [asyncio.create_task(journal.wait(after=None, wait=1)) for _ in range(MAX_WAITERS)]
        await asyncio.sleep(0.02)
        assert journal.waiting == MAX_WAITERS
        with pytest.raises(TooManyWaiters):
            await journal.wait(after=None, wait=1)
        journal.publish("node.added", actor=PERSON)
        results = await asyncio.gather(*tasks)
        assert all(len(r["events"]) == 1 for r in results)

    asyncio.run(scenario())


def test_runs_remember_their_actor_and_dedupe_batch_events():
    journal = CanvasEventJournal()
    journal.note_run("r1", CODEX)
    assert journal.run_actor("r1") == CODEX
    assert journal.run_actor("nope") == {"kind": "anonymous"}
    assert journal.first_run_event("r1", "n1", "run.started") is True
    assert journal.first_run_event("r1", "n1", "run.started") is False
    journal.forget_run("r1")
    assert journal.first_run_event("r1", "n1", "run.started") is True


# -- formatting -------------------------------------------------------------

def test_format_event_names_the_actor():
    event = {"seq": 57, "at": None, "kind": "node.moved", "actor": PERSON, "summary": "moved n3, n4"}
    assert format_event(event) == "[57] --:--:--  Person  moved n3, n4"
    anonymous = {**event, "actor": {"kind": "anonymous"}}
    assert "Unnamed client" in format_event(anonymous)
    replaced = {"seq": 3, "kind": "canvas.replaced", "actor": PERSON, "data": {"reason": "project-open"}}
    assert "Canvas replaced (project-open) — node ids restarted; run nebula look" in format_event(replaced)
    params = {"seq": 4, "kind": "node.params", "actor": CODEX, "summary": "set prompt on X (n4)",
              "data": {"keys": ["prompt"], "values": {"prompt": "warm"}}}
    assert format_event(params).endswith('Codex  set prompt on X (n4): prompt="warm"')


def test_snapshot_footer_gives_the_watch_cursor():
    text = format_snapshot({"view": {}, "nodes": [], "events": {"journal": "abc", "cursor": 12}})
    assert "EVENTS: cursor 12 (nebula watch --since 12)" in text


# -- HTTP -------------------------------------------------------------------

@pytest.fixture
def api(monkeypatch):
    import main as main_module

    graph = CLIGraph()
    journal = CanvasEventJournal()
    sent: list[dict] = []

    async def capture(data):
        sent.append(data)

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "selection_context", SelectionContextStore())
    monkeypatch.setattr(main_module, "canvas_events", journal)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module, "_check_workspace_revision", lambda *a: None)
    monkeypatch.setattr(main_module, "_workspace_context",
                        lambda: {"activeProjectId": PROJECT, "workspaceRevision": "rev"})
    return TestClient(main_module.app), graph, journal, main_module


def _kinds(journal: CanvasEventJournal) -> list[tuple[str, str]]:
    return [(e["kind"], e["actor"]["kind"]) for e in journal.read(after=0, limit=100)["events"]]


def test_edits_are_attributed_to_person_agent_or_anonymous(api):
    client, _graph, journal, _ = api
    person = client.post("/api/graph/node", headers=BROWSER,
                         json={"definitionId": "text-input", "params": {"value": "a"}}).json()["id"]
    agent = client.post("/api/graph/node", headers=AGENT,
                        json={"definitionId": "text-input", "params": {"value": "b"}}).json()["id"]
    client.post("/api/graph/node", json={"definitionId": "text-input", "params": {"value": "c"}})
    events = journal.read(after=0)["events"]
    assert [(e["kind"], e["actor"]["kind"], e.get("nodeId")) for e in events] == [
        ("node.added", "person", person),
        ("node.added", "agent", agent),
        ("node.added", "anonymous", "n3"),
    ]
    assert events[1]["actor"]["name"] == "Claude Code"
    assert events[0]["data"]["definitionId"] == "text-input"
    assert events[0]["projectId"] == PROJECT


def test_param_updates_journal_only_changed_keys(api):
    client, graph, journal, _ = api
    node = graph.add_node("gpt-image-2-5-generate", {"quality": "low"})
    client.put(f"/api/graph/node/{node}", headers=BROWSER, json={"params": {"quality": "low"}})
    assert journal.latest == 0
    client.put(f"/api/graph/node/{node}", headers=BROWSER, json={"params": {"quality": "high"}})
    (event,) = journal.read(after=0)["events"]
    assert event["kind"] == "node.params" and event["data"]["keys"] == ["quality"]
    assert event["data"]["values"] == {"quality": "high"}
    assert event["summary"] == f"set quality on GPT Image 2.5 ({node})"


def test_small_layout_nudges_are_not_moves(api):
    client, graph, journal, _ = api
    first = graph.add_node("text-input", {}, position={"x": 0, "y": 0})
    second = graph.add_node("text-input", {}, position={"x": 100, "y": 0})
    client.put("/api/graph/layout", headers=BROWSER,
               json={"positions": {first: {"x": 3, "y": 4}, second: {"x": 100, "y": 0}}})
    assert journal.latest == 0
    client.put("/api/graph/layout", headers=BROWSER,
               json={"positions": {first: {"x": 50, "y": 4}, second: {"x": 100, "y": 9}}})
    (event,) = journal.read(after=0)["events"]
    assert event["kind"] == "node.moved" and event["actor"] == PERSON
    assert event["data"] == {"nodeIds": [first, second], "count": 2}
    assert event["summary"] == f"moved {first}, {second}"


def test_first_drag_of_an_agent_created_node_is_a_move(api):
    # `nebula create` stores no position; the canvas draws the node at its
    # auto-layout spot, so the person's first drag must still reach agents.
    client, graph, journal, _ = api
    node = graph.add_node("text-input", {})
    still = graph.add_node("text-input", {})
    # Drawn at (0, 100) and (300, 100). Saving `still` where it was drawn is not a move.
    client.put("/api/graph/layout", headers=BROWSER,
               json={"positions": {node: {"x": 120, "y": 260}, still: {"x": 300, "y": 100}}})
    (event,) = journal.read(after=0)["events"]
    assert event["kind"] == "node.moved" and event["actor"] == PERSON
    assert event["data"] == {"nodeIds": [node], "count": 1}


def test_unchanged_selection_is_not_journaled(api):
    client, graph, journal, _ = api
    node = graph.add_node("text-input", {})
    client.post("/api/canvas/selection", headers=BROWSER, json={"nodeIds": [node]})
    client.post("/api/canvas/selection", headers=BROWSER, json={"nodeIds": [node]})
    client.post("/api/canvas/selection", headers=BROWSER, json={"nodeIds": []})
    assert [(e["kind"], e["data"]["count"]) for e in journal.read(after=0)["events"]] == [
        ("selection.changed", 1),
        ("selection.changed", 0),
    ]


def test_wiring_unwiring_and_delete_are_journaled(api):
    client, graph, journal, _ = api
    text = graph.add_node("text-input", {"value": "x"})
    image = graph.add_node("gpt-image-2-5-generate", {})
    wire = {"source": text, "sourceHandle": "text", "target": image, "targetHandle": "prompt"}
    assert client.post("/api/graph/connect", headers=AGENT, json=wire).status_code == 200
    assert client.request("DELETE", "/api/graph/edge", headers=BROWSER, json=wire).status_code == 200
    assert client.delete(f"/api/graph/node/{image}", headers=BROWSER).status_code == 200
    events = journal.read(after=0)["events"]
    assert [(e["kind"], e["actor"]["kind"]) for e in events] == [
        ("edge.added", "agent"), ("edge.removed", "person"), ("node.removed", "person"),
    ]
    assert events[0]["data"] == wire
    assert events[2]["data"] == {"name": "GPT Image 2.5", "definitionId": "gpt-image-2-5-generate"}


def test_cluster_journals_each_node_and_wire(api):
    client, _graph, journal, _ = api
    body = {
        "nodes": [{"tempId": "a", "definitionId": "text-input", "params": {"value": "x"}},
                  {"tempId": "b", "definitionId": "gpt-image-2-5-generate", "params": {}}],
        "edges": [{"source": "a", "sourceHandle": "text", "target": "b", "targetHandle": "prompt"}],
    }
    assert client.post("/api/graph/cluster", headers=BROWSER, json=body).status_code == 200
    assert [kind for kind, _ in _kinds(journal)] == ["node.added", "node.added", "edge.added"]


def test_import_tags_the_project_and_clear_is_journaled(api):
    client, graph, journal, _ = api
    graph.add_node("text-input", {})
    imported = client.post("/api/graph/import", headers=BROWSER, json={
        "nodes": [{"id": "x1", "definitionId": "text-input", "params": {"value": "hi"}}], "edges": []})
    assert imported.status_code == 200
    assert client.delete("/api/graph", headers=BROWSER).status_code == 200
    events = journal.read(after=0)["events"]
    assert [e["kind"] for e in events] == ["canvas.replaced", "canvas.cleared"]
    assert events[0]["data"] == {"reason": "import"} and events[0]["projectId"] == PROJECT


def test_execution_events_carry_the_run_starters_identity(api):
    _client, graph, journal, main_module = api
    node = graph.add_node("text-input", {"value": "x"})
    journal.note_run("r1", CODEX)

    async def scenario():
        await main_module._emit_and_sync(ExecutingEvent(node_id=node, run_id="r1"))
        await main_module._emit_and_sync(ExecutingEvent(node_id=node, run_id="r1"))  # batch variant
        await main_module._emit_and_sync(ExecutedEvent(node_id=node, run_id="r1", outputs={}))
        await main_module._emit_and_sync(ErrorEvent(node_id=node, run_id="r1", error="raw",
                                                    friendly="Out of credits"))
        await main_module._emit_and_sync(ExecutingEvent(node_id="quick-temp", run_id="r1"))

    asyncio.run(scenario())
    events = journal.read(after=0)["events"]
    assert [(e["kind"], e["actor"]) for e in events] == [
        ("run.started", CODEX), ("run.finished", CODEX), ("run.failed", CODEX),
    ]
    assert events[2]["data"] == {"runId": "r1", "error": "Out of credits"}


def test_snapshot_gives_the_cursor(api):
    client, _graph, journal, _ = api
    journal.publish("node.added", actor=PERSON)
    snap = client.get("/api/canvas/snapshot").json()
    assert snap["events"] == {"journal": journal.journal_id, "cursor": 1}


def test_events_endpoint_validates_and_filters_own_events(api):
    client, _graph, journal, _ = api
    for bad in ("after=-1", "wait=abc", "limit=0", "limit=101", "kinds=bogus", "self=maybe", "journal=XYZ!",
                "nope=1"):
        assert client.get(f"/api/canvas/events?{bad}").status_code == 422, bad
    journal.publish("node.added", actor={"kind": "agent", "id": "ext:claude-code", "name": "Claude Code"})
    journal.publish("node.added", actor=PERSON)
    mine_skipped = client.get("/api/canvas/events?after=0", headers=AGENT).json()
    assert [e["seq"] for e in mine_skipped["events"]] == [2] and mine_skipped["cursor"] == 2
    with_self = client.get("/api/canvas/events?after=0&self=1", headers=AGENT).json()
    assert [e["seq"] for e in with_self["events"]] == [1, 2]


def test_events_endpoint_times_out(api):
    client, _graph, _journal, _ = api
    result = client.get("/api/canvas/events?wait=0.2").json()
    assert result["timedOut"] is True and result["events"] == []


def test_events_endpoint_returns_an_event_published_during_the_wait(api):
    _client, _graph, journal, main_module = api

    async def scenario():
        transport = httpx.ASGITransport(app=main_module.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
            async def later():
                await asyncio.sleep(0.1)
                journal.publish("pin.added", actor=PERSON, summary="left a note")

            task = asyncio.create_task(later())
            response = await http.get("/api/canvas/events", params={"wait": 5}, headers=AGENT)
            await task
            return response

    response = asyncio.run(scenario())
    body = response.json()
    assert response.status_code == 200 and body["timedOut"] is False
    assert [e["kind"] for e in body["events"]] == ["pin.added"]


def test_events_endpoint_refuses_beyond_the_waiter_cap(api, monkeypatch):
    client, _graph, journal, _ = api

    async def full(**_kwargs):
        raise TooManyWaiters("full")

    monkeypatch.setattr(journal, "wait", full)
    assert client.get("/api/canvas/events?wait=1").status_code == 429


# -- CLI --------------------------------------------------------------------

class FakeClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls: list[dict] = []

    def get_canvas_events(self, params, timeout=300.0, agent_name=None):
        self.calls.append({"params": dict(params), "timeout": timeout, "agent_name": agent_name})
        return self.responses.pop(0)


def _response(cursor, events=(), **extra):
    return {"journal": "abc123abc123", "cursor": cursor, "oldest": 1, "latest": cursor, "gap": False,
            "reset": False, "more": False, "timedOut": not events, "projectId": None,
            "events": list(events), **extra}


EVENT = {"seq": 5, "at": None, "kind": "node.moved", "actor": PERSON, "summary": "moved n3"}


def test_watch_once_prints_the_batch_and_the_next_cursor():
    out = io.StringIO()
    client = FakeClient([_response(4), _response(5, [EVENT])])
    code = run_watch(client, once=True, out=out, agent_name="Codex")
    assert code == 0
    assert out.getvalue().splitlines() == [
        "[5] --:--:--  Person  moved n3",
        "cursor 5 · next: nebula watch --once --since 5",
    ]
    assert "after" not in client.calls[0]["params"]
    assert client.calls[1]["params"]["after"] == 4
    assert client.calls[1]["params"]["journal"] == "abc123abc123"
    assert client.calls[0]["agent_name"] == "Codex"


def test_watch_times_out_with_exit_code_2(capsys):
    clock = Clock()
    client = FakeClient([_response(0)])
    original = client.get_canvas_events

    def slow(params, timeout=300.0, agent_name=None):
        clock.now += 30
        return original(params, timeout, agent_name)

    client.get_canvas_events = slow
    out = io.StringIO()
    assert run_watch(client, once=True, timeout=20, out=out, clock=clock) == 2
    assert "No canvas changes in 20s." in out.getvalue()


def test_watch_stream_json_lines_and_gap_notice():
    clock = Clock()
    responses = [_response(5, [EVENT]), _response(9, [{**EVENT, "seq": 9}], gap=True, oldest=8)]
    client = FakeClient(responses)
    original = client.get_canvas_events

    def tick(params, timeout=300.0, agent_name=None):
        clock.now += 10
        return original(params, timeout, agent_name)

    client.get_canvas_events = tick
    out = io.StringIO()
    code = run_watch(client, as_json=True, since=2, timeout=20, out=out, clock=clock)
    assert code == 0
    lines = [json.loads(line) for line in out.getvalue().splitlines()]
    assert [line["seq"] for line in lines] == [5, 9]
    assert client.calls[1]["params"]["after"] == 5


def test_watch_ctrl_c_exits_130():
    class Interrupting:
        def get_canvas_events(self, *a, **k):
            raise KeyboardInterrupt

    assert run_watch(Interrupting(), out=io.StringIO()) == 130


def test_watch_subcommand_parses():
    from cli.__main__ import build_parser

    args = build_parser().parse_args(["watch", "--once", "--kinds", "node,pin", "--since", "4", "--as", "Codex"])
    assert (args.once, args.kinds, args.since, args.agent_name) == (True, "node,pin", 4, "Codex")


# -- MCP --------------------------------------------------------------------

def test_mcp_wait_for_canvas_change_loops_until_events(monkeypatch):
    import mcp_server

    calls: list[dict] = []
    replies = [_response(3), _response(4, [EVENT])]

    def fake_request(method, url, *, headers, timeout, **kwargs):
        calls.append({"url": url, "headers": headers, "timeout": timeout, **kwargs})
        return httpx.Response(200, json=replies.pop(0), request=httpx.Request(method, url))

    monkeypatch.setattr(mcp_server.httpx, "request", fake_request)
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")

    result = mcp_server.wait_for_canvas_change(since=2, timeout_seconds=1000, kinds=["node", "pin"])
    assert result["events"] == [EVENT]
    first, second = calls
    assert first["url"].endswith("/api/canvas/events")
    assert first["headers"] == {"X-Nebula-Agent": "Claude Code"}
    assert first["params"] == {"wait": 25.0, "limit": 50, "after": 2, "kinds": "node,pin"}
    assert first["timeout"] == 35.0
    assert second["params"]["after"] == 3 and second["params"]["journal"] == "abc123abc123"


def test_mcp_wait_for_canvas_change_respects_the_cap(monkeypatch):
    import mcp_server

    def fake_request(method, url, *, headers, timeout, **kwargs):
        return httpx.Response(200, json=_response(0), request=httpx.Request(method, url))

    monkeypatch.setattr(mcp_server.httpx, "request", fake_request)
    result = mcp_server.wait_for_canvas_change(timeout_seconds=0)
    assert result["timedOut"] is True and result["events"] == []


def test_mcp_wait_notes_anonymous_changes_when_unnamed(monkeypatch):
    # Without NEBULA_AGENT_NAME the CLI sends no name, so the agent's own CLI
    # edits arrive as anonymous; the result says so instead of implying a stranger.
    import mcp_server

    anonymous = {**EVENT, "actor": {"kind": "anonymous"}}

    def fake_request(method, url, *, headers, timeout, **kwargs):
        return httpx.Response(200, json=_response(4, [anonymous]), request=httpx.Request(method, url))

    monkeypatch.setattr(mcp_server.httpx, "request", fake_request)
    monkeypatch.delenv("NEBULA_AGENT_NAME", raising=False)
    result = mcp_server.wait_for_canvas_change(timeout_seconds=1)
    assert "NEBULA_AGENT_NAME" in result["note"]
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    assert "note" not in mcp_server.wait_for_canvas_change(timeout_seconds=1)
