"""A wait for the person's answers rides through a Nebula restart (Q125 item 1, final pass).

Question sets are kept with the project, so they outlive a restart; the wait
for them should too. Within the wait's own budget, MCP get_answers
(wait_seconds) and `nebula answers --wait` retry a request Nebula never
answered (connection refused, reset, no answer) with a short backoff, then
keep waiting. A real HTTP answer (404, 403, a 5xx with a body) is never
retried and ends the call as before, and a cancelled MCP call still ends at
once, during the backoff too. get_answers is a read, so a retry can't repeat
a write. get_proposal is unchanged: proposals don't survive a restart.
"""
from __future__ import annotations

import argparse
import io
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import anyio
import httpx
import pytest
from mcp import types
from mcp.shared.exceptions import McpError
from mcp.shared.memory import create_connected_server_and_client_session

import mcp_server
import nebula_api
from cli.client import NebulaClient
from cli.commands import questions as questions_cmd
from nebula_api import NebulaAPIError

OPEN = {"questions": {"id": "qs_0000aaaa", "status": "open", "questions": [], "answers": None}}
ANSWERED = {"questions": {"id": "qs_0000aaaa", "status": "answered", "questions": [],
                          "answers": [{"questionId": "q1", "answered": True, "choices": ["Wide"], "text": None}]}}


def _down() -> NebulaAPIError:
    return NebulaAPIError("Nebula isn't running at http://127.0.0.1:1. Start Nebula, then retry.", kind="connect")


def _no_answer() -> NebulaAPIError:
    return NebulaAPIError("Nebula didn't answer GET /api/canvas/questions/qs_0000aaaa in time.", kind="timeout")


class ScriptedApi:
    """Answers each request with the next step of ``script`` (the last one repeats)."""

    def __init__(self, *script):
        self.script = list(script)
        self.calls = 0

    def request(self, method, path, **kwargs):
        self.calls += 1
        step = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        if isinstance(step, BaseException):
            raise step
        return json.loads(json.dumps(step))


@pytest.fixture
def fast(monkeypatch):
    monkeypatch.setattr(mcp_server, "_POLL_SECONDS", 0.05)
    monkeypatch.setattr(nebula_api, "RETRY_FIRST_SECONDS", 0.02)
    monkeypatch.setattr(nebula_api, "RETRY_MAX_SECONDS", 0.05)


def _script(monkeypatch, *steps) -> ScriptedApi:
    api = ScriptedApi(*steps)
    monkeypatch.setattr(mcp_server, "_api", lambda: api)
    return api


# -- MCP get_answers -----------------------------------------------------------------

def test_get_answers_retries_while_nebula_restarts(fast, monkeypatch):
    api = _script(monkeypatch, OPEN, _down(), _down(), _no_answer(), ANSWERED)
    result = mcp_server.get_answers("qs_0000aaaa", wait_seconds=10)
    assert result["questions"]["status"] == "answered"
    assert api.calls == 5


@pytest.mark.parametrize("refusal", [
    NebulaAPIError("No question set qs_0000aaaa: ask again", status=404),
    NebulaAPIError("Only the agent that asked reads them", status=403),
    NebulaAPIError("Project storage is unavailable", status=500, payload={"detail": "Project storage is unavailable"}),
])
def test_a_real_http_answer_is_never_retried(fast, monkeypatch, refusal):
    api = _script(monkeypatch, OPEN, refusal, ANSWERED)
    with pytest.raises(NebulaAPIError) as caught:
        mcp_server.get_answers("qs_0000aaaa", wait_seconds=10)
    assert caught.value.status == refusal.status
    assert api.calls == 2


def test_nebula_down_from_the_start_fails_at_once(fast, monkeypatch):
    # Not a restart: nothing answered this call yet (a wrong URL, Nebula not started).
    api = _script(monkeypatch, _down())
    started = time.monotonic()
    with pytest.raises(NebulaAPIError) as caught:
        mcp_server.get_answers("qs_0000aaaa", wait_seconds=10)
    assert caught.value.kind == "connect" and api.calls == 1
    assert time.monotonic() - started < 1


def _from(cause: Exception, kind: str = "connect") -> NebulaAPIError:
    """NebulaAPIError the way NebulaAPI.send raises it: ``from`` the httpx error."""
    try:
        raise NebulaAPIError(f"GET /api/canvas/questions/qs_0000aaaa failed: {cause}", kind=kind) from cause
    except NebulaAPIError as exc:
        return exc


@pytest.mark.parametrize("dropped", [
    _from(httpx.RemoteProtocolError("Server disconnected without sending a response.")),
    _from(httpx.ReadError("Connection reset by peer")),
    _from(httpx.ReadTimeout("timed out"), kind="timeout"),
])
def test_a_first_poll_dropped_mid_request_rides_through(fast, monkeypatch, dropped):
    # Review: Nebula took the first long poll, then went away (a crash, a
    # SIGKILL, the desktop sidecar's 5 s grace). It was there, so this is a
    # restart mid-wait, not a Nebula that was never running.
    api = _script(monkeypatch, dropped, _down(), ANSWERED)
    result = mcp_server.get_answers("qs_0000aaaa", wait_seconds=10)
    assert result["questions"]["status"] == "answered"
    assert api.calls == 3


@pytest.mark.parametrize("refused", [
    _from(httpx.ConnectError("[Errno 61] Connection refused")),
    _from(httpx.ConnectTimeout("timed out"), kind="timeout"),
])
def test_a_refused_first_connect_still_fails_at_once(fast, monkeypatch, refused):
    api = _script(monkeypatch, refused, ANSWERED)
    started = time.monotonic()
    with pytest.raises(NebulaAPIError):
        mcp_server.get_answers("qs_0000aaaa", wait_seconds=10)
    assert api.calls == 1
    assert time.monotonic() - started < 1


class _DropsFirst(BaseHTTPRequestHandler):
    """Accepts the first GET and closes it with no response; answers after that."""
    served = 0

    def do_GET(self) -> None:  # noqa: N802
        cls = type(self)
        cls.served += 1
        if cls.served == 1:
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            return
        data = json.dumps(ANSWERED).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args) -> None:
        pass


def test_a_real_first_poll_dropped_by_nebula_rides_through(fast, monkeypatch):
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_APP_TOKEN", raising=False)
    monkeypatch.setattr(_DropsFirst, "served", 0)
    server = ThreadingHTTPServer(("127.0.0.1", 0), _DropsFirst)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setattr(mcp_server, "_base_url", f"http://127.0.0.1:{server.server_address[1]}")
    try:
        result = mcp_server.get_answers("qs_0000aaaa", wait_seconds=10)
    finally:
        server.shutdown()
        server.server_close()
    assert result["questions"]["status"] == "answered"
    assert _DropsFirst.served == 2


def test_a_real_refused_first_connect_fails_at_once(fast, monkeypatch):
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_APP_TOKEN", raising=False)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    monkeypatch.setattr(mcp_server, "_base_url", f"http://127.0.0.1:{port}")
    started = time.monotonic()
    with pytest.raises(NebulaAPIError) as caught:
        mcp_server.get_answers("qs_0000aaaa", wait_seconds=10)
    assert caught.value.kind == "connect"
    assert time.monotonic() - started < 1


def test_without_a_wait_there_is_no_retry(fast, monkeypatch):
    api = _script(monkeypatch, _down())
    with pytest.raises(NebulaAPIError):
        mcp_server.get_answers("qs_0000aaaa")
    assert api.calls == 1


def test_the_retries_stop_at_the_wait_budget(fast, monkeypatch):
    _script(monkeypatch, OPEN, _down())
    started = time.monotonic()
    with pytest.raises(NebulaAPIError) as caught:
        mcp_server.get_answers("qs_0000aaaa", wait_seconds=1.0)
    took = time.monotonic() - started
    assert caught.value.kind == "connect"
    assert 0.9 <= took < 2.0, took


def test_get_proposal_is_unchanged(fast, monkeypatch):
    api = _script(monkeypatch, {"proposal": {"id": "p1", "status": "open"}}, _down(),
                  {"proposal": {"id": "p1", "status": "accepted"}})
    with pytest.raises(NebulaAPIError):
        mcp_server.get_proposal("p1", wait_seconds=10)
    assert api.calls == 2


class _Restarting(BaseHTTPRequestHandler):
    """First launch: answers once (open), then dies mid-request. Second launch: answered."""
    launch = 1
    served = 0
    died = threading.Event()

    def do_GET(self) -> None:  # noqa: N802
        cls = type(self)
        cls.served += 1
        if cls.launch == 1 and cls.served > 1:
            # Killed while holding the long-poll: the connection closes without an answer.
            cls.died.set()
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            return
        data = json.dumps(OPEN if cls.launch == 1 else ANSWERED).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args) -> None:
        pass


def _serve(port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", port), _Restarting)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def test_get_answers_rides_through_a_real_restart(monkeypatch):
    monkeypatch.setattr(mcp_server, "_POLL_SECONDS", 0.2)
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_APP_TOKEN", raising=False)
    monkeypatch.setattr(_Restarting, "launch", 1)
    monkeypatch.setattr(_Restarting, "served", 0)
    monkeypatch.setattr(_Restarting, "died", threading.Event())
    first = _serve(0)
    port = first.server_address[1]
    monkeypatch.setattr(mcp_server, "_base_url", f"http://127.0.0.1:{port}")
    second: list[ThreadingHTTPServer] = []

    def restart() -> None:
        _Restarting.died.wait(10)
        first.shutdown()
        first.server_close()
        time.sleep(1.0)  # down: connections are refused meanwhile
        _Restarting.launch = 2
        second.append(_serve(port))

    threading.Thread(target=restart, daemon=True).start()
    try:
        result = mcp_server.get_answers("qs_0000aaaa", wait_seconds=20)
    finally:
        for server in second:
            server.shutdown()
            server.server_close()
    assert result["questions"]["status"] == "answered"
    assert _Restarting.launch == 2


def _borrowed() -> int:
    return mcp_server._CALL_LIMITER.borrowed_tokens + mcp_server._WAIT_LIMITER.borrowed_tokens


def test_a_cancel_during_the_backoff_ends_the_call_at_once(monkeypatch):
    # A long backoff, so the cancel lands inside it.
    monkeypatch.setattr(mcp_server, "_POLL_SECONDS", 0.05)
    monkeypatch.setattr(nebula_api, "RETRY_FIRST_SECONDS", 3.0)
    monkeypatch.setattr(nebula_api, "RETRY_MAX_SECONDS", 3.0)
    api = _script(monkeypatch, OPEN, _down())

    async def main() -> tuple[str, float, bool]:
        outcome: dict[str, str] = {}
        async with create_connected_server_and_client_session(mcp_server.mcp._mcp_server) as session:
            async def call() -> None:
                try:
                    await session.call_tool("get_answers", {"question_id": "qs_0000aaaa", "wait_seconds": 30})
                    outcome["result"] = "returned"
                except McpError as exc:
                    outcome["result"] = exc.error.message

            async with anyio.create_task_group() as group:
                group.start_soon(call)
                await anyio.sleep(0.4)
                assert api.calls == 2  # one open read, one refused: now in the backoff
                assert _borrowed() == 1
                (request_id,) = session._response_streams
                await session.send_notification(types.ClientNotification(types.CancelledNotification(
                    params=types.CancelledNotificationParams(requestId=request_id))))
                cancelled = time.monotonic()
                while _borrowed() and time.monotonic() - cancelled < 5:
                    await anyio.sleep(0.02)
                freed = time.monotonic() - cancelled
            await anyio.sleep(0.1)
            monkeypatch.setattr(mcp_server, "_api", lambda: ScriptedApi({"ok": True}))
            alive = not (await session.call_tool("look_at_canvas", {})).isError
        return outcome["result"], freed, alive

    result, freed, alive = anyio.run(main)
    assert result == "Request cancelled"
    assert freed < 1.0, f"the cancelled get_answers held its thread {freed:.1f} s in the backoff"
    assert alive
    assert api.calls == 2  # no retry after the cancel


# -- the CLI: nebula answers --wait -------------------------------------------------------

class Clock:
    def __init__(self) -> None:
        self.now = 1000.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


class ScriptedClient(NebulaClient):
    def __init__(self, api: ScriptedApi, clock: Clock) -> None:
        super().__init__("http://127.0.0.1:1")
        self._scripted = api
        self._clock = clock

    @property
    def api(self):  # type: ignore[override]
        scripted, clock = self._scripted, self._clock

        class _Timed:
            def request(self, method, path, **kwargs):
                clock.now += 0.5  # each poll takes a moment
                return scripted.request(method, path, **kwargs)

        return _Timed()


def _answers_args(wait: float) -> argparse.Namespace:
    return argparse.Namespace(question_id="qs_0000aaaa", wait=wait, json=True, agent_name=None)


def _run(*steps, wait: float = 60.0):
    clock = Clock()
    api = ScriptedApi(*steps)
    out = io.StringIO()
    code = questions_cmd.run_answers(ScriptedClient(api, clock), _answers_args(wait), out=out, clock=clock,
                                     sleep=clock.sleep)
    return code, out.getvalue(), api, clock


def test_cli_answers_wait_rides_through_a_restart():
    code, out, api, clock = _run(OPEN, OPEN, _down(), _down(), _no_answer(), ANSWERED)
    assert code == questions_cmd.EXIT_ANSWERED
    assert json.loads(out)["questions"]["status"] == "answered"
    assert api.calls == 6 and len(clock.slept) == 3
    assert all(0 < s <= nebula_api.RETRY_MAX_SECONDS for s in clock.slept)


def test_cli_a_real_http_answer_mid_wait_is_not_retried(capsys):
    with pytest.raises(SystemExit) as caught:
        _run(OPEN, NebulaAPIError("No question set qs_0000aaaa: ask again", status=404), ANSWERED)
    assert caught.value.code == 1
    assert "ask again" in capsys.readouterr().err


def test_cli_retries_stop_at_the_wait_budget(capsys):
    with pytest.raises(SystemExit) as caught:
        _run(OPEN, OPEN, _down(), wait=5.0)
    assert caught.value.code == 1
    assert "cannot connect" in capsys.readouterr().err


def test_cli_nebula_down_from_the_start_fails_at_once(capsys):
    with pytest.raises(SystemExit):
        _run(_down())
    assert "cannot connect" in capsys.readouterr().err


def test_cli_ctrl_c_during_the_backoff_ends_the_wait():
    clock = Clock()
    api = ScriptedApi(OPEN, OPEN, _down())

    def interrupted(seconds: float) -> None:
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        questions_cmd.run_answers(ScriptedClient(api, clock), _answers_args(60.0), out=io.StringIO(), clock=clock,
                                  sleep=interrupted)
    assert api.calls == 3
