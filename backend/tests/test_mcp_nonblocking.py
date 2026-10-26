"""The MCP server keeps answering while one of its tools waits.

A client's calls share one server process (Claude Code's subagents share the
parent's connection), and FastMCP runs a plain `def` tool inline on the event
loop. A `wait_for_canvas_change` long-poll then froze every other call from
that client: measured 2026-10-20, a main agent's look_at_canvas blocked 82.6 s
behind a subagent's wait. These tests go through the MCP protocol (an
in-memory client session) against a fake Nebula on an ephemeral port.
"""
from __future__ import annotations

import contextvars
import inspect
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import anyio
import pytest
from mcp import types
from mcp.shared.exceptions import McpError
from mcp.shared.memory import create_connected_server_and_client_session

import mcp_server

# Tools whose own `async def` body offloads every blocking call. Any other
# tool must be a plain function registered through `_tool`, which runs it on
# a worker thread. Adding a name here means reading that body first.
NATIVE_ASYNC_TOOLS = {"run_nodes", "get_run", "moodboard_create", "moodboard_add"}


class _FakeNebula(BaseHTTPRequestHandler):
    """/api/canvas/events, a proposal and a question set hold for their `wait`, node "slow" for 1 s; the rest answer at once."""

    def do_GET(self) -> None:  # noqa: N802 (http.server's name)
        url = urlsplit(self.path)
        if url.path == "/api/canvas/events":
            time.sleep(float(parse_qs(url.query).get("wait", ["0"])[0]))
            body = {"journal": "abc", "cursor": 0, "events": [], "gap": False, "reset": False}
        elif url.path == "/api/agent/nodes/slow":
            time.sleep(1.0)
            body = {"ok": True, "path": url.path}
        elif url.path.startswith("/api/canvas/proposals/"):
            time.sleep(float(parse_qs(url.query).get("wait", ["0"])[0]))
            body = {"proposal": {"id": "p1", "status": "open"}}
        elif url.path.startswith("/api/canvas/questions/"):
            time.sleep(float(parse_qs(url.query).get("wait", ["0"])[0]))
            body = {"questions": {"id": "s1", "status": "open"}}
        else:
            body = {"ok": True, "path": url.path}
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args) -> None:
        pass


@pytest.fixture
def fake_nebula(monkeypatch):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeNebula)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_APP_TOKEN", raising=False)
    monkeypatch.setattr(mcp_server, "_base_url", f"http://127.0.0.1:{server.server_address[1]}")
    try:
        yield
    finally:
        server.shutdown()
        server.server_close()


async def _wait_then_look(waits: int, wait_seconds: float) -> dict[str, float]:
    """Start `waits` long-polls, then look_at_canvas 0.3 s later; seconds from the start."""
    out: dict[str, float] = {}
    async with create_connected_server_and_client_session(mcp_server.mcp._mcp_server) as session:
        start = time.monotonic()

        async def wait(index: int) -> None:
            result = await session.call_tool("wait_for_canvas_change", {"timeout_seconds": wait_seconds})
            assert not result.isError, result.content
            out[f"wait{index}"] = time.monotonic() - start

        async def look() -> None:
            await anyio.sleep(0.3)
            result = await session.call_tool("look_at_canvas", {})
            assert not result.isError, result.content
            out["look"] = time.monotonic() - start

        async with anyio.create_task_group() as group:
            for index in range(waits):
                group.start_soon(wait, index)
            group.start_soon(look)
    return out


def test_a_wait_in_flight_does_not_block_another_call(fake_nebula):
    times = anyio.run(_wait_then_look, 1, 3.0)
    # On a server that runs the wait on its event loop, look lands with the
    # wait (about 3 s). Off the loop it is one local round trip.
    assert times["look"] < 1.5, times
    assert times["wait0"] >= 2.9, times


def test_long_polls_cannot_starve_other_calls(fake_nebula, monkeypatch):
    # More waits than the wait pool holds: the extra one queues, but ordinary
    # calls have their own pool and still answer at once.
    monkeypatch.setattr(mcp_server._WAIT_LIMITER, "total_tokens", 2)
    times = anyio.run(_wait_then_look, 3, 2.0)
    _assert_look_never_queued_behind_the_waits(times)


def _assert_look_never_queued_behind_the_waits(times: dict[str, float]) -> None:
    """Order, not a wall-clock bound (review 9 of PR #114: `look < 1.5 s`
    failed at 1.65 s on a loaded machine). Starved, look takes a slot only
    once a wait gives one back, so it lands after the first wait ends; with
    its own pool it lands while both slots are still held. Load delays look
    and the waits alike, so the order holds where a fixed bound doesn't."""
    ends = sorted(times[f"wait{index}"] for index in range(3))
    # The waits held their slots (2 s each) and the third queued behind them.
    assert ends[0] >= 1.9 and ends[2] >= ends[0] + 1.9, times
    assert times["look"] < ends[0], times


def test_the_starvation_check_catches_a_shared_pool(fake_nebula, monkeypatch):
    # The check above, on a server whose ordinary calls share the waits' pool:
    # it must fail, or it proves nothing.
    shared = anyio.CapacityLimiter(2)
    monkeypatch.setattr(mcp_server, "_WAIT_LIMITER", shared)
    monkeypatch.setattr(mcp_server, "_CALL_LIMITER", shared)
    times = anyio.run(_wait_then_look, 3, 2.0)
    with pytest.raises(AssertionError):
        _assert_look_never_queued_behind_the_waits(times)


def _borrowed() -> int:
    return mcp_server._CALL_LIMITER.borrowed_tokens + mcp_server._WAIT_LIMITER.borrowed_tokens


@pytest.mark.parametrize("tool, args, freed_within", [
    # The long-polls stop at their next poll.
    ("wait_for_canvas_change", {"timeout_seconds": 8}, 1.5),
    ("get_proposal", {"proposal_id": "p1", "wait_seconds": 8}, 1.5),
    ("get_answers", {"question_id": "s1", "wait_seconds": 8}, 1.5),
    # One request can't be interrupted; it ends when Nebula answers (1 s).
    ("describe_node", {"definition_id": "slow"}, 1.5),
])
def test_a_cancelled_call_ends_cleanly(fake_nebula, monkeypatch, tool, args, freed_within):
    # Claude Code sends notifications/cancelled when a call is interrupted; the
    # server answers "Request cancelled" at once. Then (1) the worker thread
    # must give its slot back soon, not poll on to the wait's own deadline (up
    # to 300 s), and (2) the call must end as cancelled: if it returns
    # normally, the SDK responds a second time, asserts, and the whole server
    # (every agent's tools) goes down.
    monkeypatch.setattr(mcp_server, "_POLL_SECONDS", 0.5)

    async def main() -> tuple[str, float, bool]:
        outcome: dict[str, str] = {}
        async with create_connected_server_and_client_session(mcp_server.mcp._mcp_server) as session:
            async def call() -> None:
                try:
                    await session.call_tool(tool, args)
                    outcome["result"] = "returned"
                except McpError as exc:
                    outcome["result"] = exc.error.message

            async with anyio.create_task_group() as group:
                group.start_soon(call)
                await anyio.sleep(0.3)
                assert _borrowed() == 1
                (request_id,) = session._response_streams  # the call in flight
                await session.send_notification(types.ClientNotification(types.CancelledNotification(
                    params=types.CancelledNotificationParams(requestId=request_id))))
                cancelled = time.monotonic()
                while _borrowed() and time.monotonic() - cancelled < 5:
                    await anyio.sleep(0.05)
                freed = time.monotonic() - cancelled
            await anyio.sleep(0.2)
            alive = not (await session.call_tool("look_at_canvas", {})).isError
        return outcome["result"], freed, alive

    result, freed, alive = anyio.run(main)
    assert result == "Request cancelled"
    assert freed < freed_within, f"the cancelled {tool} held its thread {freed:.1f} s"
    assert alive


def test_the_waits_still_wait_when_called_directly(fake_nebula, monkeypatch):
    # The cancel check is a no-op off an AnyIO worker thread (the CLI, tests).
    monkeypatch.setattr(mcp_server, "_POLL_SECONDS", 0.2)
    started = time.monotonic()
    assert mcp_server.wait_for_canvas_change(timeout_seconds=0.5)["timedOut"] is True
    assert time.monotonic() - started >= 0.5


def test_every_tool_is_async_or_offloaded():
    tools = mcp_server.mcp._tool_manager.list_tools()
    assert len(tools) >= 36
    for tool in tools:
        assert tool.is_async, f"{tool.name} would run on the event loop; register it with @_tool"
        if tool.name in NATIVE_ASYNC_TOOLS:
            source = inspect.getsource(tool.fn)
            assert "_offload(" in source, f"{tool.name} is async but offloads nothing"
        else:
            assert getattr(tool.fn, "_nebula_offloaded", False), (
                f"{tool.name} is async but not offloaded by @_tool; if its body never blocks, "
                "add it to NATIVE_ASYNC_TOOLS after reading it")
    # Resources and prompts run their functions on the event loop too.
    manager = mcp_server.mcp._resource_manager
    for item in [*manager.list_resources(), *manager.list_templates(), *mcp_server.mcp._prompt_manager.list_prompts()]:
        fn = getattr(item, "fn", None)
        assert fn is None or inspect.iscoroutinefunction(fn), f"{item.name} would run on the event loop"


def test_offloaded_tools_keep_the_callers_context():
    # The agent workspace scope (services/agent_workspaces.py) is a ContextVar
    # set before mcp.run(); a tool on a worker thread must still see it.
    probe: contextvars.ContextVar[str] = contextvars.ContextVar("probe", default="unset")

    def read() -> str:
        return probe.get()

    async def main() -> str:
        probe.set("scoped")
        return await mcp_server._offload(read)

    assert anyio.run(main) == "scoped"


def test_the_module_functions_stay_callable_directly(fake_nebula):
    # Tests and other callers use the plain functions; only the MCP
    # registration is wrapped.
    assert mcp_server.look_at_canvas()["path"] == "/api/canvas/snapshot"
